import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { RunDao } from './run.dao';

/**
 * Real-driver DAO spec for the run listings the service specs only fake
 * ("Mirrors the real query's chat-only scoping…" in chat.service.spec, the
 * pending-counts orphan filter in graph-executor.service.spec). Same in-memory
 * better-sqlite3 harness as item.dao.spec: real entities, the daemon config's
 * discovery settings, actual SQL.
 */
describe('RunDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: RunDao;

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
    dao = new RunDao(orm.em.fork());
  });

  describe('listChats', () => {
    it('lists chat runs only (workflowId null), newest first', async () => {
      // Oldest inserted first, with explicit createdAt values: a dropped
      // ORDER BY (insertion order) flips the expected order below.
      const older = await dao.create({ createdAt: new Date(1_000) });
      const newer = await dao.create({ createdAt: new Date(2_000) });
      await dao.create({ workflowId: 'wf-1', createdAt: new Date(3_000) });

      const chats = await dao.listChats();

      expect(chats.map((run) => run.id)).toEqual([newer.id, older.id]);
    });
  });

  describe('listRunningChats', () => {
    it('scopes to running chats — non-running chats and workflow runs are excluded', async () => {
      await dao.create({ status: 'pending' });
      const running = await dao.create({ status: 'running' });
      await dao.create({ status: 'completed' });
      // A mid-turn WORKFLOW run is the graph executor's reconcile concern.
      await dao.create({ workflowId: 'wf-1', status: 'running' });

      const stale = await dao.listRunningChats();

      expect(stale.map((run) => run.id)).toEqual([running.id]);
    });
  });

  describe('listWorkflowRuns', () => {
    it('lists workflow runs only (workflowId set), newest first', async () => {
      const older = await dao.create({
        workflowId: 'wf-1',
        createdAt: new Date(1_000),
      });
      const newer = await dao.create({
        workflowId: 'wf-2',
        createdAt: new Date(2_000),
      });
      await dao.create({ createdAt: new Date(3_000) }); // chat run

      const runs = await dao.listWorkflowRuns();

      expect(runs.map((run) => run.id)).toEqual([newer.id, older.id]);
    });
  });

  describe('listRunningWorkflowRuns', () => {
    it('treats pending AND running workflow runs as orphans; terminal and chat runs never appear', async () => {
      // A workflow run is created `running`, but pending still counts as
      // non-terminal (see the DAO doc comment) — pin both.
      const pending = await dao.create({
        workflowId: 'wf-1',
        status: 'pending',
      });
      const running = await dao.create({
        workflowId: 'wf-1',
        status: 'running',
      });
      await dao.create({ workflowId: 'wf-1', status: 'completed' });
      await dao.create({ workflowId: 'wf-1', status: 'failed' });
      await dao.create({ workflowId: 'wf-1', status: 'cancelled' });
      await dao.create({ status: 'running' }); // mid-turn chat, not an orphan here

      const stale = await dao.listRunningWorkflowRuns();

      // No ORDER BY on this query — compare as a set.
      expect(stale.map((run) => run.id).sort()).toEqual(
        [pending.id, running.id].sort(),
      );
    });
  });

  describe('retitle', () => {
    // The predicate is the whole no-clobber guarantee, and it lives in SQL —
    // the service's own read is only an early exit, so a fake cannot stand in
    // for these.
    //
    // Every read-back goes through a FRESH dao: `nativeUpdate` writes past the
    // identity map, so the entity the writing fork still holds keeps the old
    // title. That is the DAO's documented caveat, and reading it back through
    // the same fork would assert the cache rather than the row.
    const stored = async (id: string): Promise<string | null> =>
      (await new RunDao(orm.em.fork()).getById(id))?.title ?? null;
    it('names a run whose title is still null', async () => {
      const run = await dao.create({});

      await expect(
        dao.retitle(run.id, 'Fix Conflicts Worktree', null),
      ).resolves.toBe(true);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');
    });

    it('refuses to name a run that has since been renamed', async () => {
      // The race the service cannot close by reading first: resolving a title
      // takes several reads, and a PATCH landing inside that window must win.
      const run = await dao.create({ title: 'My own name for this' });

      await expect(dao.retitle(run.id, 'Auto Generated', null)).resolves.toBe(
        false,
      );
      expect(await stored(run.id)).toBe('My own name for this');
    });

    it('replaces one title with another only while the old one is still there', async () => {
      const run = await dao.create({ title: 'look at the merge conflicts' });

      await expect(
        dao.retitle(
          run.id,
          'Fix Conflicts Worktree',
          'look at the merge conflicts',
        ),
      ).resolves.toBe(true);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');

      // The same upgrade replayed against the title it no longer holds.
      await expect(
        dao.retitle(run.id, 'Something Else', 'look at the merge conflicts'),
      ).resolves.toBe(false);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');
    });

    it('never touches another run', async () => {
      const mine = await dao.create({});
      const theirs = await dao.create({});

      await dao.retitle(mine.id, 'Mine', null);

      expect(await stored(theirs.id)).toBeNull();
    });
  });
});
