import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ChatSearchService } from './chat-search.service';

interface StoredRow {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
  createdAt: Date;
}

function row(seq: number, payload: unknown): StoredRow {
  return {
    seq,
    kind: 'message',
    role: 'assistant',
    payload: JSON.stringify(payload),
    createdAt: new Date('2026-09-05T12:00:00.000Z'),
  };
}

function build(rows: StoredRow[], runExists = true) {
  const searchByText = vi.fn(
    (_runId: string, _terms: readonly string[], limit: number) =>
      Promise.resolve(rows.slice(0, limit)),
  );
  const service = new ChatSearchService(
    { fork: () => ({}) } as unknown as EntityManager,
    { searchByText } as unknown as ItemDao,
    {
      getById: () => Promise.resolve(runExists ? { id: 'run-1' } : null),
    } as unknown as RunDao,
  );
  return { service, searchByText };
}

describe('ChatSearchService', () => {
  it('quotes the payload as it was WRITTEN, not the lowercased index form', () => {
    // The column is lowercased so SQLite's ASCII-only `LIKE` can match any
    // script. Quoting it back would show the user their own sentence in lower
    // case, which reads as a bug in the app rather than a detail of the column.
    const { service } = build([row(7, { text: 'Проверка Bloom-фильтра' })]);

    return service.search('run-1', 'проверка').then((result) => {
      expect(result.hits[0]?.snippet).toBe('Проверка Bloom-фильтра');
    });
  });

  it('asks for every term, so more words narrow rather than widen', async () => {
    // The ARGUMENT is all this can assert — the double ignores it, and the
    // predicate itself is pinned against a real database in `item.dao.spec.ts`,
    // which is where an `$and` widened to `$or` is actually caught.
    const { service, searchByText } = build([row(1, { text: 'auth geniro' })]);

    await service.search('run-1', 'Auth   Geniro');

    expect(searchByText.mock.calls[0]?.[1]).toEqual(['auth', 'geniro']);
  });

  it('still quotes the row when no term appears in it literally', async () => {
    // Reachable, not hypothetical: `searchTerms` leaves `%` and `_` in a term,
    // and the DAO keeps them live as LIKE wildcards — so `100%` matches a row
    // reading `100 apples` in SQL while no literal `100%` is in the text. There
    // is then nothing to window on, and the head of the line is the honest
    // answer; returning no quote at all would leave the row unexplained.
    const { service } = build([row(3, { text: '100 apples, then a pause' })]);

    const result = await service.search('run-1', '100%');

    expect(result.hits[0]?.snippet).toContain('100 apples');
  });

  it('carries the hit back to its place in the run', async () => {
    const { service } = build([row(4211, { text: 'the bloom filter' })]);

    const result = await service.search('run-1', 'bloom');

    expect(result.hits[0]?.seq).toBe(4211);
    expect(result.hits[0]?.kind).toBe('message');
    expect(result.hits[0]?.createdAt).toBe('2026-09-05T12:00:00.000Z');
  });

  it('says the list is incomplete rather than truncating in silence', async () => {
    // A capped list that says nothing reads as "that is all there is" — which
    // is the exact failure a daemon-side search exists to avoid.
    const rows = Array.from({ length: 6 }, (_, index) =>
      row(index, { text: 'needle' }),
    );
    const { service, searchByText } = build(rows);

    const result = await service.search('run-1', 'needle', 5);

    expect(result.hits).toHaveLength(5);
    expect(result.partialReason).toContain('newest 5');
    // One more than asked for, purely to learn that there ARE more.
    expect(searchByText.mock.calls[0]?.[2]).toBe(6);
  });

  it('says nothing about being partial when the whole answer fits', async () => {
    const { service } = build([row(1, { text: 'needle' })]);

    expect(
      (await service.search('run-1', 'needle', 5)).partialReason,
    ).toBeNull();
  });

  it('answers a blank query with no hits instead of every row', async () => {
    const { service, searchByText } = build([row(1, { text: 'anything' })]);

    const result = await service.search('run-1', '   ');

    expect(result.hits).toEqual([]);
    expect(searchByText).not.toHaveBeenCalled();
  });

  it('refuses a run that does not exist, rather than answering "no matches"', async () => {
    // Different answers: only one of them is the client's mistake.
    const { service } = build([], false);

    await expect(service.search('nope', 'anything')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
