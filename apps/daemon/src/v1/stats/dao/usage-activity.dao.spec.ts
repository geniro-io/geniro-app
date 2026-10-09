import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageActivityDao } from './usage-activity.dao';

/**
 * Real-driver DAO spec, on the same harness as `usage-event.dao.spec.ts`: MikroORM
 * boots on an in-memory better-sqlite3 database with the real entity and runs the
 * actual SQL. The unique index that refuses a second thread or pull request row is
 * exercised here rather than mirrored, and so is the half-open range the Stats page
 * reads.
 */
describe('UsageActivityDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageActivityDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity],
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
    dao = new UsageActivityDao(orm.em.fork());
  });

  const at = (iso: string): Date => new Date(iso);

  const pullRequest = (
    overrides: Partial<
      Parameters<UsageActivityDao['insertPullRequestOnce']>[0]
    > = {},
  ) => ({
    runId: 'run-a',
    owner: 'geniro-io',
    repo: 'geniro-app',
    number: 218,
    url: 'https://github.com/geniro-io/geniro-app/pull/218',
    occurredAt: at('2026-08-10T12:05:00.000Z'),
    ...overrides,
  });

  describe('the unique index on dedupKey', () => {
    it('refuses a second row for a key already recorded, even one written around the DAO', async () => {
      // The DAO's own lookup answers first, so the index is the only guard a racing
      // writer meets, and a row written directly has to meet it.
      await dao.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z'));

      await expect(
        orm.em
          .fork()
          .getRepository(UsageActivity)
          .insert({
            id: 'written-around-the-dao',
            kind: 'thread',
            runId: 'run-b',
            occurredAt: at('2026-08-11T09:00:00.000Z'),
            dedupKey: 'thread:run-a',
            createdAt: at('2026-08-11T09:00:00.000Z'),
            updatedAt: at('2026-08-11T09:00:00.000Z'),
          }),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });

  describe('insertThreadOnce', () => {
    it('writes a thread once and refuses the same run again, keeping the first time', async () => {
      expect(
        await dao.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z')),
      ).toBe(true);
      expect(
        await dao.insertThreadOnce('run-a', at('2026-08-11T09:00:00.000Z')),
      ).toBe(false);

      const rows = await dao.getAll({ kind: 'thread' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'thread', runId: 'run-a' });
      expect(rows[0]?.occurredAt).toEqual(at('2026-08-10T12:00:00.000Z'));
    });

    it('answers a race the lookup missed as already recorded, rather than throwing', async () => {
      const em = orm.em.fork();
      const racing = new UsageActivityDao(em);
      await racing.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z'));
      // The lookup misses the row, as it would if another writer committed after it looked.
      const findOne = vi
        .spyOn(em.getRepository(UsageActivity), 'findOne')
        .mockResolvedValueOnce(null);

      await expect(
        racing.insertThreadOnce('run-a', at('2026-08-11T09:00:00.000Z')),
      ).resolves.toBe(false);
      expect(findOne).toHaveBeenCalledTimes(1);
      findOne.mockRestore();
    });
  });

  describe('insertPullRequestOnce', () => {
    it('writes a pull request once per thread and identity', async () => {
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(true);
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(false);

      const rows = await dao.getAll({ kind: 'pull_request' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        prOwner: 'geniro-io',
        prRepo: 'geniro-app',
        prNumber: 218,
        prUrl: 'https://github.com/geniro-io/geniro-app/pull/218',
      });
    });

    it('keeps a second pull request of the same thread, and the same number in another thread', async () => {
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(true);
      expect(
        await dao.insertPullRequestOnce(
          pullRequest({
            number: 219,
            url: 'https://github.com/geniro-io/geniro-app/pull/219',
          }),
        ),
      ).toBe(true);
      expect(
        await dao.insertPullRequestOnce(pullRequest({ runId: 'run-b' })),
      ).toBe(true);
      expect(await dao.getAll({ kind: 'pull_request' })).toHaveLength(3);
    });
  });

  describe('insertLineSnapshot', () => {
    it('keeps every snapshot of a thread and round-trips its figures, including the partial flag', async () => {
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-10T12:00:00.000Z'),
        linesAdded: 10,
        linesRemoved: 2,
        partial: false,
      });
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-10T13:00:00.000Z'),
        linesAdded: 25,
        linesRemoved: 4,
        partial: true,
      });

      const rows = await dao.inRange(
        'lines',
        at('2026-08-10T00:00:00.000Z'),
        at('2026-08-11T00:00:00.000Z'),
      );
      expect(
        rows.map((row) => [row.linesAdded, row.linesRemoved, row.partial]),
      ).toEqual([
        [10, 2, false],
        [25, 4, true],
      ]);
    });
  });

  describe('inRange', () => {
    it('answers a half-open range of one kind, oldest first', async () => {
      await dao.insertThreadOnce('run-late', at('2026-08-12T00:00:00.000Z'));
      await dao.insertThreadOnce('run-later', at('2026-08-10T18:00:00.000Z'));
      await dao.insertThreadOnce('run-start', at('2026-08-10T00:00:00.000Z'));
      await dao.insertThreadOnce('run-end', at('2026-08-11T00:00:00.000Z'));
      await dao.insertPullRequestOnce(
        pullRequest({ occurredAt: at('2026-08-10T06:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        'thread',
        at('2026-08-10T00:00:00.000Z'),
        at('2026-08-11T00:00:00.000Z'),
      );
      // `from` is inclusive, `to` is exclusive, and the pull request is another kind.
      expect(rows.map((row) => row.runId)).toEqual(['run-start', 'run-later']);
    });
  });

  describe('earliestOccurredAt', () => {
    it('answers the earliest row of the kinds asked for, and null when there is none', async () => {
      expect(
        await dao.earliestOccurredAt(['thread', 'pull_request']),
      ).toBeNull();

      await dao.insertThreadOnce('run-a', at('2026-08-05T12:00:00.000Z'));
      await dao.insertPullRequestOnce(
        pullRequest({ occurredAt: at('2026-08-06T12:00:00.000Z') }),
      );

      expect(await dao.earliestOccurredAt(['thread', 'pull_request'])).toEqual(
        at('2026-08-05T12:00:00.000Z'),
      );
    });

    it('answers only the kinds it is asked for, so a lines snapshot cannot answer the floor', async () => {
      await dao.insertThreadOnce('run-a', at('2026-08-05T12:00:00.000Z'));
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-02T09:00:00.000Z'),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });

      expect(await dao.earliestOccurredAt(['thread', 'pull_request'])).toEqual(
        at('2026-08-05T12:00:00.000Z'),
      );
    });
  });

  describe('peakLinesBefore', () => {
    it("returns each thread's highest total before the period starts, per count", async () => {
      const period = at('2026-08-11T00:00:00.000Z');
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-10T12:00:00.000Z'),
        linesAdded: 10,
        linesRemoved: 1,
        partial: false,
      });
      // A dip after the peak is not the baseline: growth is counted past the peak.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-10T18:00:00.000Z'),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });
      // A snapshot exactly at the period's start belongs to the period, not its baseline.
      await dao.insertLineSnapshot({
        runId: 'run-d',
        occurredAt: period,
        linesAdded: 7,
        linesRemoved: 0,
        partial: false,
      });
      await dao.insertLineSnapshot({
        runId: 'run-b',
        occurredAt: at('2026-08-11T09:00:00.000Z'),
        linesAdded: 5,
        linesRemoved: 0,
        partial: false,
      });
      // An earlier, smaller snapshot of the same thread is below its peak.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-09T12:00:00.000Z'),
        linesAdded: 3,
        linesRemoved: 0,
        partial: false,
      });

      // The highest REMOVED count sits on a different snapshot from the highest added one, so a peak
      // taken from a single row for both counts cannot pass.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: at('2026-08-10T20:00:00.000Z'),
        linesAdded: 6,
        linesRemoved: 3,
        partial: false,
      });
      const peaks = await dao.peakLinesBefore(
        ['run-a', 'run-b', 'run-c', 'run-d'],
        period,
      );
      expect(peaks.get('run-a')).toEqual({ linesAdded: 10, linesRemoved: 3 });
      expect(peaks.has('run-b')).toBe(false);
      expect(peaks.has('run-c')).toBe(false);
      expect(peaks.has('run-d')).toBe(false);
    });

    it('leaves a snapshot with either count unmeasured out whole, rather than counting its other half', async () => {
      // The insert path never writes a null count, so a row like this is written around the DAO —
      // the same way the unique index is probed above. Its 99 must not become run-x's baseline.
      await orm.em
        .fork()
        .getRepository(UsageActivity)
        .insert({
          id: 'unmeasured-half',
          kind: 'lines',
          runId: 'run-x',
          occurredAt: at('2026-08-10T12:00:00.000Z'),
          dedupKey: 'lines:unmeasured-half',
          linesAdded: 99,
          linesRemoved: null,
          partial: false,
          createdAt: at('2026-08-10T12:00:00.000Z'),
          updatedAt: at('2026-08-10T12:00:00.000Z'),
        });
      // The mirror case: the added count is unmeasured, and the removed count must not stand alone either.
      await orm.em
        .fork()
        .getRepository(UsageActivity)
        .insert({
          id: 'unmeasured-added',
          kind: 'lines',
          runId: 'run-x',
          occurredAt: at('2026-08-10T11:00:00.000Z'),
          dedupKey: 'lines:unmeasured-added',
          linesAdded: null,
          linesRemoved: 77,
          partial: false,
          createdAt: at('2026-08-10T11:00:00.000Z'),
          updatedAt: at('2026-08-10T11:00:00.000Z'),
        });
      await dao.insertLineSnapshot({
        runId: 'run-x',
        occurredAt: at('2026-08-10T13:00:00.000Z'),
        linesAdded: 6,
        linesRemoved: 2,
        partial: false,
      });

      const peaks = await dao.peakLinesBefore(
        ['run-x'],
        at('2026-08-11T00:00:00.000Z'),
      );
      expect(peaks.get('run-x')).toEqual({ linesAdded: 6, linesRemoved: 2 });
    });

    it('reads every thread in one statement, not one per thread', async () => {
      const em = orm.em.fork();
      const reader = new UsageActivityDao(em);
      // The database is asked through the connection, so a statement per thread would show here
      // as one call per thread however the rows were fetched.
      const execute = vi.spyOn(em.getConnection(), 'execute');

      await reader.peakLinesBefore(
        ['run-a', 'run-b', 'run-c', 'run-d'],
        at('2026-08-11T00:00:00.000Z'),
      );

      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockRestore();
    });
  });
});
