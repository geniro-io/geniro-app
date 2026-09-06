import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import { SearchTextBackfillService } from './search-text-backfill.service';

interface Row {
  id: string;
  payload: string;
  searchText: string | null;
}

/**
 * A faithful double of the two DAO methods the sweep drives.
 *
 * Faithful in the two respects that decide the loop. `missingSearchText`
 * selects on `searchText === null`, exactly as the real predicate does, so a
 * row the service declines to write really does come back in the next batch — a
 * double that simply paged through a fixed list would make the drain-forever bug
 * untestable. And it honours the `afterId` CURSOR the real query pages on, in
 * primary-key order, so a case CAN observe what the service passes.
 *
 * What that does not buy, stated so nobody assumes it: the cursor is a
 * PERFORMANCE mechanism over a self-draining predicate, so dropping the advance
 * leaves every case here green — the uncursored pass still fills every row. The
 * advance is pinned by the case that watches the argument; the `$gt` operator it
 * relies on is pinned against a real database in `item.dao.spec.ts`.
 */
function fakeItemDao(rows: Row[]): {
  dao: ItemDao;
  writes: number;
  rows: Row[];
} {
  const state = { writes: 0 };
  const dao = {
    missingSearchText: (limit: number, afterId: string | null = null) =>
      Promise.resolve(
        [...rows]
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter(
            (row) =>
              row.searchText === null && (afterId === null || row.id > afterId),
          )
          .slice(0, limit),
      ),
    rememberSearchText: (id: string, searchText: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) {
        row.searchText = searchText;
      }
      state.writes += 1;
      return Promise.resolve();
    },
  } as unknown as ItemDao;
  return {
    dao,
    get writes() {
      return state.writes;
    },
    rows,
  };
}

/**
 * `transactional` is part of the contract now — the sweep wraps each batch in
 * one, so a double without it fails at the first batch.
 *
 * It hands the callback THIS manager, where a real MikroORM `transactional`
 * forks one. That difference is worth knowing rather than papering over: this
 * double cannot catch a regression that stopped routing the writes through the
 * manager it is given, because here the two are the same object. What it does
 * pin is the loop — that each batch is wrapped, and that the sweep still drains,
 * advances its cursor and retires correctly around the wrapper.
 */
const em = {
  fork: () => em,
  transactional: <T>(work: (tx: EntityManager) => Promise<T>) => work(em),
} as unknown as EntityManager;

describe('SearchTextBackfillService', () => {
  let dir: string;
  let markerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-search-backfill-'));
    markerPath = join(dir, 'search-text-backfilled');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fills every row that has no search text yet', async () => {
    const fake = fakeItemDao([
      {
        id: 'a',
        payload: JSON.stringify({ text: 'the bloom filter is sized wrong' }),
        searchText: null,
      },
      {
        id: 'b',
        payload: JSON.stringify({
          name: 'Bash',
          input: { command: 'pnpm full-check' },
        }),
        searchText: null,
      },
    ]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    expect(await service.backfill()).toBe(2);
    expect(fake.rows.map((row) => row.searchText)).toEqual([
      'the bloom filter is sized wrong',
      'bash pnpm full-check',
    ]);
  });

  it('leaves a row that was already filled alone', async () => {
    const fake = fakeItemDao([
      { id: 'a', payload: '{"text":"old"}', searchText: 'already here' },
      { id: 'b', payload: '{"text":"new"}', searchText: null },
    ]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    expect(await service.backfill()).toBe(1);
    expect(fake.rows[0]?.searchText).toBe('already here');
  });

  it('writes an unparseable payload as an empty string rather than skipping it', async () => {
    // The load-bearing one. The batch query selects on `searchText IS NULL`, so
    // a row this pass declines to write comes straight back in the next batch —
    // inside a live daemon that is an endless loop, not a missed row. Reverting
    // the catch to `continue` hangs this test rather than failing an assertion,
    // which is itself the signal.
    const fake = fakeItemDao([
      { id: 'a', payload: 'not json at all', searchText: null },
    ]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    expect(await service.backfill()).toBe(1);
    expect(fake.rows[0]?.searchText).toBe('');
  });

  it('carries the cursor forward, so a batch resumes where the last one stopped', async () => {
    // The advance itself, which nothing else can catch: the predicate is
    // self-draining, so a sweep that never moved `afterId` still fills the table
    // and every other case here stays green. Only the ARGUMENT shows it.
    const rows = Array.from({ length: 600 }, (_, index) => ({
      id: `row-${String(index).padStart(4, '0')}`,
      payload: JSON.stringify({ text: `m${index}` }),
      searchText: null,
    }));
    const fake = fakeItemDao(rows);
    const asked: (string | null)[] = [];
    const dao = {
      missingSearchText: (limit: number, afterId: string | null = null) => {
        asked.push(afterId);
        return fake.dao.missingSearchText(limit, afterId);
      },
      rememberSearchText: fake.dao.rememberSearchText.bind(fake.dao),
    } as unknown as ItemDao;
    const service = new SearchTextBackfillService(dao, em, markerPath);

    await service.backfill();

    // First pass uncursored, second resuming after the batch that was written.
    expect(asked[0]).toBeNull();
    expect(asked[1]).toBe('row-0499');
  });

  it('goes back for a row the cursor passed over before retiring', async () => {
    // The hazard the primary-key cursor introduces, and the reason an uncursored
    // pass is what retires the sweep. A row whose write does not stick stays
    // null BEHIND the cursor, so a cursored pass reports "nothing left" while
    // the table is not drained — retiring there would leave that row
    // unsearchable for good, which is exactly the completeness the old
    // self-draining predicate gave away for free.
    const fake = fakeItemDao([
      { id: 'a', payload: '{"text":"first"}', searchText: null },
      { id: 'b', payload: '{"text":"second"}', searchText: null },
    ]);
    // `a` refuses the first write and accepts any later one — so it is filled
    // only if the sweep comes back for it after the cursor has moved past.
    let refusals = 1;
    const dao = {
      ...fake.dao,
      missingSearchText: fake.dao.missingSearchText.bind(fake.dao),
      rememberSearchText: (id: string, searchText: string) => {
        if (id === 'a' && refusals > 0) {
          refusals -= 1;
          return Promise.resolve();
        }
        const row = fake.rows.find((candidate) => candidate.id === id);
        if (row) {
          row.searchText = searchText;
        }
        return Promise.resolve();
      },
    } as unknown as ItemDao;
    const service = new SearchTextBackfillService(dao, em, markerPath);

    await service.backfill();

    expect(fake.rows.find((row) => row.id === 'a')?.searchText).toBe('first');
    expect(existsSync(markerPath)).toBe(true);
  });

  it('retires itself with a marker once the table is drained', async () => {
    const fake = fakeItemDao([
      { id: 'a', payload: '{"text":"hello"}', searchText: null },
    ]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    await service.backfill();

    expect(existsSync(markerPath)).toBe(true);
  });

  it('retires itself even when it found nothing to do', async () => {
    // A fresh install must not re-scan for the life of the app.
    const fake = fakeItemDao([]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    expect(await service.backfill()).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
  });

  it('still reports the rows it filled when the marker cannot be WRITTEN', async () => {
    // The rows are already filled by the time the marker is written, so a
    // failure there costs one more pass next launch — which will find nothing
    // to do — and must not be turned into a failed backfill. Driven through a
    // path whose parent does not exist rather than a mocked `writeFile`, so it
    // is node's own refusal being swallowed.
    const fake = fakeItemDao([
      { id: 'a', payload: '{"text":"only row"}', searchText: null },
    ]);
    const unwritable = join(dir, 'no-such-directory', 'marker');
    const service = new SearchTextBackfillService(fake.dao, em, unwritable);

    expect(await service.backfill()).toBe(1);
    expect(fake.rows[0]?.searchText).toBe('only row');
    expect(existsSync(unwritable)).toBe(false);
  });

  it('does nothing at all once the marker exists', async () => {
    writeFileSync(markerPath, '2026-09-05T00:00:00.000Z\n', 'utf8');
    const fake = fakeItemDao([
      { id: 'a', payload: '{"text":"hello"}', searchText: null },
    ]);
    const service = new SearchTextBackfillService(fake.dao, em, markerPath);

    expect(await service.backfill()).toBeNull();
    expect(fake.writes).toBe(0);
  });

  it('never throws out of the boot entry point', async () => {
    const dao = {
      missingSearchText: () => Promise.reject(new Error('database is gone')),
    } as unknown as ItemDao;
    const service = new SearchTextBackfillService(dao, em, markerPath);

    await expect(service.backfillQuietly()).resolves.toBeUndefined();
    // And it did NOT retire itself on a failure — the next launch tries again.
    expect(existsSync(markerPath)).toBe(false);
  });
});
