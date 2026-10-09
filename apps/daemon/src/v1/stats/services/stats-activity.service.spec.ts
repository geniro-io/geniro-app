import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException, NotFoundException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { Run } from '../../runs/entity/run.entity';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import {
  POLLED_SPEND_SEQ,
  type UsageEventInput,
  type UsageRecordedEvent,
} from '../stats.types';
import { ProjectRootsService } from './project-roots.service';
import { StatsService } from './stats.service';
import { UsageEventBus } from './usage-events.bus';

/**
 * The threads' activity on the Stats page, end to end: the real ledger and activity
 * tables and the real fold, on an in-memory database. The day a fact is filed under is
 * a property of the SQL range and the local-day arithmetic working together, so the
 * assertions read the figures the page would show.
 *
 * Every date is built in local time, which is how the fold files a fact: a test that
 * named a UTC instant would pass or fail depending on the machine's timezone.
 */
describe('StatsService — what the threads did (in-memory sqlite)', () => {
  let orm: MikroORM;
  let usageDao: UsageEventDao;
  let activityDao: UsageActivityDao;
  let service: StatsService;
  let bus: UsageEventBus;

  const day = (date: number, hour = 12): Date => new Date(2026, 7, date, hour);

  function turn(
    overrides: Pick<UsageEventInput, 'runId' | 'seq' | 'occurredAt'> &
      Partial<UsageEventInput>,
  ): UsageEventInput {
    return {
      nodeId: null,
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      workflowName: null,
      costUsd: 0.25,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: 4_000,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      ...overrides,
    };
  }

  function statsWith(runDao: RunDao): StatsService {
    const em = orm.em.fork();
    return new StatsService(
      em,
      new UsageEventDao(em),
      new AgentAdapterRegistry([]),
      new ProjectRootsService(em),
      runDao,
      new UsageActivityDao(em),
      bus,
    );
  }

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity, UsageEvent, Run],
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
    const em = orm.em.fork();
    usageDao = new UsageEventDao(em);
    activityDao = new UsageActivityDao(em);
    bus = new UsageEventBus();
    service = statsWith(new RunDao(em));
    // The ledger's first turn is the page's lower bound, so every period below starts on or after it.
    await usageDao.recordOnce(
      turn({ runId: 'run-a', seq: 0, occurredAt: day(1, 9) }),
    );
  });

  const range = (from: number, to: number) => ({
    from: day(from, 0).toISOString(),
    to: day(to, 0).toISOString(),
  });

  describe('usage()', () => {
    it('counts the threads and pull requests created in the period, day by day', async () => {
      await activityDao.insertThreadOnce('run-a', day(10, 9));
      await activityDao.insertThreadOnce('run-b', day(10, 15));
      await activityDao.insertThreadOnce('run-c', day(11, 9));
      await activityDao.insertPullRequestOnce({
        runId: 'run-a',
        owner: 'geniro-io',
        repo: 'geniro-app',
        number: 218,
        url: 'https://github.com/geniro-io/geniro-app/pull/218',
        occurredAt: day(10, 10),
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({
        threadsCreated: 3,
        pullRequests: 1,
      });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({
        threadsCreated: 2,
        pullRequests: 1,
      });
      expect(byDate.get('2026-08-11')).toMatchObject({
        threadsCreated: 1,
        pullRequests: 0,
      });
    });

    it('sums the lines a thread added between its snapshots, filed on the day each was taken', async () => {
      // The snapshot before the period is the baseline, so the first in-period growth is
      // 15, not the whole 25.
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: day(9),
        linesAdded: 10,
        linesRemoved: 2,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: day(10, 9),
        linesAdded: 25,
        linesRemoved: 2,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: day(11, 9),
        linesAdded: 25,
        linesRemoved: 7,
        partial: false,
      });

      const stats = await service.usage(range(10, 13).from, range(10, 13).to);

      expect(stats.activity).toMatchObject({ linesAdded: 15, linesRemoved: 5 });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({
        linesAdded: 15,
        linesRemoved: 0,
      });
      // Measured with no growth: a real zero, not an unmeasured day.
      expect(byDate.get('2026-08-11')).toMatchObject({
        linesAdded: 0,
        linesRemoved: 5,
      });
      // Nothing measured on the quiet day: null, not zero.
      expect(byDate.get('2026-08-12')).toMatchObject({
        linesAdded: null,
        linesRemoved: null,
      });
    });

    it("measures a thread's first snapshot in the period whole when it has no baseline", async () => {
      await activityDao.insertLineSnapshot({
        runId: 'run-b',
        occurredAt: day(10, 9),
        linesAdded: 40,
        linesRemoved: 3,
        partial: false,
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({ linesAdded: 40, linesRemoved: 3 });
    });

    it('adds nothing for a fall back, and flags a day and the period partial when a measurement was a lower bound', async () => {
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        occurredAt: day(10, 9),
        linesAdded: 30,
        linesRemoved: 0,
        partial: true,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        occurredAt: day(11, 9),
        linesAdded: 20,
        linesRemoved: 0,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        occurredAt: day(11, 15),
        linesAdded: 36,
        linesRemoved: 0,
        partial: false,
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      // 30, then nothing for the fall back to 20, then 6 past the highest total, 30.
      expect(stats.activity).toMatchObject({
        linesAdded: 36,
        linesPartial: true,
      });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({ linesPartial: true });
      expect(byDate.get('2026-08-11')).toMatchObject({
        linesAdded: 6,
        linesPartial: false,
      });
    });

    it('counts a thread created before the ledger’s first recorded turn, in the default range', async () => {
      // A thread is recorded when it is created, which can be before its first turn. With
      // no lower bound given, the range starts at the ledger's earliest row of either kind.
      await activityDao.insertThreadOnce('run-early', day(0, 15));

      const stats = await service.usage(undefined, day(12, 0).toISOString());

      expect(stats.activity).toMatchObject({ threadsCreated: 1 });
    });

    it('keeps the default floor on the earliest thread, whatever a lines snapshot is dated', async () => {
      // A snapshot is dated by the client, so only thread and pull-request rows may answer the
      // floor: a lines row dated before the thread must not stretch the default range.
      await activityDao.insertThreadOnce('run-a', day(0, 12));
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        occurredAt: day(0, 2),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });

      const stats = await service.usage(undefined, day(12, 0).toISOString());

      expect(stats.from).toBe(day(0, 12).toISOString());
    });

    it('averages each day’s working time over the threads that reported it that day', async () => {
      // Day ten: one thread at 100s of working time is 100s. Day eleven: two threads at
      // 30s each is 30s, not the period's average.
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 1,
          occurredAt: day(10, 9),
          durationMs: 60_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 2,
          occurredAt: day(10, 11),
          durationMs: 40_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-b',
          seq: 0,
          occurredAt: day(11, 9),
          durationMs: 30_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-c',
          seq: 0,
          occurredAt: day(11, 11),
          durationMs: 30_000,
        }),
      );

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));

      expect(byDate.get('2026-08-10')).toMatchObject({
        threadsWithWorkedTime: 1,
        avgWorkedMs: 100_000,
      });
      expect(byDate.get('2026-08-11')).toMatchObject({
        threadsWithWorkedTime: 2,
        avgWorkedMs: 30_000,
      });
    });

    it('counts the threads that were active, and averages working time over the ones that reported it', async () => {
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 1,
          occurredAt: day(10, 9),
          durationMs: 60_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 2,
          occurredAt: day(10, 11),
          durationMs: 40_000,
        }),
      );
      // A cursor-like thread: its turns report no working time, so it is active but unmeasured.
      await usageDao.recordOnce(
        turn({
          runId: 'run-b',
          seq: 0,
          occurredAt: day(10, 13),
          durationMs: null,
        }),
      );
      // A polled-spend bill is not a turn, so it must not make its thread active.
      await usageDao.recordOnce(
        turn({
          runId: 'run-c',
          seq: POLLED_SPEND_SEQ,
          occurredAt: day(10, 15),
          costUsd: 2,
          durationMs: null,
        }),
      );

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({
        activeThreads: 2,
        threadsWithWorkedTime: 1,
        avgWorkedMs: 100_000,
      });
    });
  });

  describe('recordLinesSnapshot()', () => {
    it('refuses a run that no longer exists, and writes nothing', async () => {
      const gone = statsWith({
        getById: async () => null,
      } as unknown as RunDao);

      await expect(
        gone.recordLinesSnapshot({
          runId: 'gone',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await activityDao.inRange('lines', day(1, 0), day(30, 0)),
      ).toHaveLength(0);
    });

    it('refuses a measurement dated before its thread existed, and writes nothing', async () => {
      const early = statsWith({
        getById: async () => ({ id: 'run-a', createdAt: day(5, 0) }) as Run,
      } as unknown as RunDao);

      await expect(
        early.recordLinesSnapshot({
          runId: 'run-a',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
          occurredAt: day(4, 23).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await activityDao.inRange('lines', day(1, 0), day(30, 0)),
      ).toHaveLength(0);
    });

    it('refuses a measurement dated past the clock allowance, and writes nothing', async () => {
      const live = statsWith({
        getById: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);
      const now = Date.now();

      await expect(
        live.recordLinesSnapshot({
          runId: 'run-a',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
          occurredAt: new Date(now + 60 * 60_000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await activityDao.inRange(
          'lines',
          new Date(now - 86_400_000),
          new Date(now + 2 * 86_400_000),
        ),
      ).toHaveLength(0);
    });

    it('takes the time as now when the caller names none, which is what the desktop app sends', async () => {
      const live = statsWith({
        getById: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);
      const before = Date.now();

      await live.recordLinesSnapshot({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: false,
      });

      const after = Date.now();
      const rows = await activityDao.inRange(
        'lines',
        new Date(before - 1_000),
        new Date(after + 1_000),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0]?.occurredAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('writes the measurement at the time it was taken, and announces it to the open page', async () => {
      const announced: UsageRecordedEvent[] = [];
      bus.all().subscribe((event) => announced.push(event));
      const live = statsWith({
        getById: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);

      await live.recordLinesSnapshot({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: true,
        occurredAt: day(10, 9).toISOString(),
      });

      const rows = await activityDao.inRange('lines', day(10, 0), day(11, 0));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: true,
      });
      expect(announced).toEqual([
        {
          runId: 'run-a',
          nodeId: null,
          occurredAt: day(10, 9).toISOString(),
          turn: false,
        },
      ]);
    });
  });
});
