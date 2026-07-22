import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { ItemDao } from './item.dao';

/**
 * Real-driver DAO spec: the service specs run in-memory fakes that only MIRROR
 * these queries, so this suite boots MikroORM on an in-memory better-sqlite3
 * database with the real entities and executes the actual SQL — the `$gt`
 * replay cursor, the two-query head reduction, and the run scoping. The config
 * mirrors the daemon's `db/mikro-orm.config.ts` discovery settings, with
 * explicit entity classes in place of the compiled-file glob (so no
 * `dynamicImportProvider` shim is needed).
 */
describe('ItemDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ItemDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    // The module hands each DAO the app-wide EntityManager and per-request work
    // rides a fork (see chat.service) — construct on a fresh fork per test.
    dao = new ItemDao(orm.em.fork());
  });

  /** Persist one row through the DAO's own create — the production write path. */
  async function insert(
    runId: string,
    seq: number,
    kind: ItemKind = 'message',
    payload = JSON.stringify({ text: `m${seq}` }),
  ): Promise<Item> {
    return dao.create({ runId, seq, kind, payload });
  }

  describe('getByRun', () => {
    it('returns the whole transcript in seq order by default', async () => {
      // Inserted deliberately out of order — the ordering must come from the
      // query, not from insertion (rowid) order.
      await insert('run-a', 2);
      await insert('run-a', 0);
      await insert('run-a', 1);

      const items = await dao.getByRun('run-a');

      expect(items.map((i) => i.seq)).toEqual([0, 1, 2]);
    });

    it('treats afterSeq as a STRICT greater-than replay cursor', async () => {
      await insert('run-a', 0);
      await insert('run-a', 1);
      await insert('run-a', 2);

      // seq 1 already rendered → only seq 2 replays ($gt — a $gte regression
      // would re-send seq 1 here).
      expect((await dao.getByRun('run-a', 1)).map((i) => i.seq)).toEqual([2]);
      expect((await dao.getByRun('run-a', 2)).map((i) => i.seq)).toEqual([]);
      // The -1 default covers seq 0 (seq starts at 0, so 0 > -1).
      expect((await dao.getByRun('run-a', -1)).map((i) => i.seq)).toEqual([
        0, 1, 2,
      ]);
    });

    it("never leaks another run's items", async () => {
      await insert('run-a', 0);
      await insert('run-b', 0);
      await insert('run-b', 1);

      const items = await dao.getByRun('run-b');

      expect(items.map((i) => i.runId)).toEqual(['run-b', 'run-b']);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });
  });

  describe('maxSeq', () => {
    it('returns the highest seq persisted for the run, scoped to that run', async () => {
      await insert('run-a', 0);
      await insert('run-a', 5);
      await insert('run-a', 3);
      await insert('run-b', 9);

      expect(await dao.maxSeq('run-a')).toBe(5);
    });

    it('returns the -1 sentinel for a run with no items yet', async () => {
      await insert('run-b', 0);

      expect(await dao.maxSeq('run-a')).toBe(-1);
    });
  });

  describe('latestMessageTextPerRun', () => {
    it('previews the text of the highest-seq message item, per run', async () => {
      // Head row inserted FIRST so a "last row processed wins" reduction would
      // be caught too, not just a min/max mixup.
      await insert('run-a', 2, 'message', JSON.stringify({ text: 'a-latest' }));
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a-first' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b-only' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.get('run-a')).toBe('a-latest');
      expect(previews.get('run-b')).toBe('b-only');
      expect(previews.size).toBe(2);
    });

    it('reduces over MESSAGE items only — trailing non-message items do not hide the preview', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'hello' }));
      // Non-message payloads carry no `text`, so a dropped kind filter would
      // surface as an absent preview here, not a lucky pass.
      await insert('run-a', 1, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ status: 'completed' }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('hello');
    });

    it('omits runs with no message items', async () => {
      await insert('run-a', 0, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('b');
    });

    it('omits a run whose head message has no text — never falls back to an earlier message', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'early' }));
      await insert('run-a', 1, 'message', JSON.stringify({}));

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      // Only the head row (seq 1) is ever fetched; its payload has no `text`,
      // so the run is simply absent — seq 0's 'early' is never consulted.
      expect(previews.has('run-a')).toBe(false);
    });

    it('tolerates a malformed head payload — absent, never a throw', async () => {
      await insert('run-a', 0, 'message', 'not json {');
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'fine' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('fine');
    });

    it('scopes to the requested runIds; an empty request yields an empty map', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a' }));
      await insert('run-c', 0, 'message', JSON.stringify({ text: 'c' }));

      const previews = await dao.latestMessageTextPerRun(['run-a']);
      expect([...previews.keys()]).toEqual(['run-a']);

      expect((await dao.latestMessageTextPerRun([])).size).toBe(0);
    });
  });
});
