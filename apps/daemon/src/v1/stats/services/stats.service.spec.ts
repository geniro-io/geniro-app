import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';
import { StatsService } from './stats.service';

/**
 * Real database, real DAO: the range predicate is half-open and the day buckets
 * are local-time, and both are properties of the SQL and the fold working
 * together. A faked DAO would let the service's arrangement pass while the
 * query it depends on returned a different set of rows.
 */
describe('StatsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: StatsService;
  let dao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageEvent],
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
    dao = new UsageEventDao(em);
    service = new StatsService(em, dao);
  });

  /**
   * The route hands the service ISO strings; these tests are written in local
   * `Date`s because the bucketing they check is local-time. Converting here
   * keeps every case readable without weakening what it drives.
   */
  function readUsage(
    from?: Date,
    to?: Date,
  ): ReturnType<StatsService['usage']> {
    return service.usage(from?.toISOString(), to?.toISOString());
  }

  let nextSeq = 0;
  async function record(
    occurredAt: Date,
    overrides: Partial<UsageEventInput> = {},
  ): Promise<void> {
    nextSeq += 1;
    await dao.recordOnce({
      runId: 'run-a',
      nodeId: null,
      seq: nextSeq,
      occurredAt,
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      costUsd: 1,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
      thinkingTokens: 2,
      durationMs: 500,
      apiMs: 400,
      ...overrides,
    });
  }

  describe('totals', () => {
    it('sums every turn in the period', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 11, 9), { costUsd: 2.5 });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals).toMatchObject({
        turns: 2,
        costUsd: 3.5,
        inputTokens: 200,
        workedMs: 1_000,
      });
    });

    it('keeps a total null when nothing in the period reported it', async () => {
      // The cursor-agent shape: tokens, no cost.
      await record(new Date(2026, 7, 10, 9), {
        agentKind: 'cursor-agent',
        costUsd: null,
        durationMs: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.totals.costUsd).toBeNull();
      expect(stats.totals.workedMs).toBeNull();
      expect(stats.totals.inputTokens).toBe(100);
    });

    it('counts a turn on the lower bound and excludes one on the upper', async () => {
      const from = new Date(2026, 7, 10, 0, 0, 0);
      const to = new Date(2026, 7, 11, 0, 0, 0);
      await record(from);
      await record(to);

      const stats = await readUsage(from, to);

      // Half-open, so two adjacent periods never both claim the boundary turn
      // and no day is counted twice across a paged read.
      expect(stats.totals.turns).toBe(1);
    });
  });

  describe('days', () => {
    it('emits one bucket per calendar day, including days with no turns', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 12, 9));

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 13),
      );

      expect(stats.days.map((day) => day.date)).toEqual([
        '2026-08-10',
        '2026-08-11',
        '2026-08-12',
      ]);
      // The quiet day is present and empty — without it the chart would draw
      // the 10th and the 12th as adjacent.
      expect(stats.days[1]!.totals).toMatchObject({ turns: 0, costUsd: null });
    });

    it('buckets a turn by its LOCAL day', async () => {
      // Late evening local time — a UTC-keyed bucket would file this under the
      // 11th for anyone east of Greenwich.
      await record(new Date(2026, 7, 10, 23, 30));

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.days).toHaveLength(1);
      expect(stats.days[0]).toMatchObject({
        date: '2026-08-10',
        totals: { turns: 1 },
      });
    });

    it('sums several turns on the same day into one bucket', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 10, 17), { costUsd: 4 });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.days[0]!.totals).toMatchObject({ turns: 2, costUsd: 5 });
    });
  });

  describe('breakdowns', () => {
    it('groups by agent, model and project, dearest first', async () => {
      await record(new Date(2026, 7, 10, 9), {
        agentKind: 'claude',
        model: 'claude-opus-5',
        cwd: '/work/a',
        costUsd: 1,
      });
      await record(new Date(2026, 7, 10, 10), {
        agentKind: 'cursor-agent',
        model: 'composer-1',
        cwd: '/work/b',
        costUsd: 5,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.byAgent.map((group) => group.key)).toEqual([
        'cursor-agent',
        'claude',
      ]);
      expect(stats.byAgent[0]!.totals.costUsd).toBe(5);
      expect(stats.byModel.map((group) => group.key)).toEqual([
        'composer-1',
        'claude-opus-5',
      ]);
      expect(stats.byProject.map((group) => group.key)).toEqual([
        '/work/b',
        '/work/a',
      ]);
    });

    it('ranks by turn count when no slice reported a cost', async () => {
      await record(new Date(2026, 7, 10, 9), { cwd: '/work/a', costUsd: null });
      await record(new Date(2026, 7, 10, 10), {
        cwd: '/work/b',
        costUsd: null,
      });
      await record(new Date(2026, 7, 10, 11), {
        cwd: '/work/b',
        costUsd: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      // Without the turn-count tiebreak these come back in map-insertion order,
      // so /work/a would lead despite being the smaller slice.
      expect(stats.byProject.map((group) => group.key)).toEqual([
        '/work/b',
        '/work/a',
      ]);
    });

    it('leaves an unknown dimension null for the client to label', async () => {
      await record(new Date(2026, 7, 10, 9), {
        agentKind: null,
        model: null,
        cwd: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      // Never a daemon-invented "(unknown)" string the UI would have to parse
      // back out.
      expect(stats.byAgent[0]!.key).toBeNull();
      expect(stats.byModel[0]!.key).toBeNull();
      expect(stats.byProject[0]!.key).toBeNull();
    });
  });

  describe('range resolution', () => {
    it('echoes the resolved range it actually reported on', async () => {
      const from = new Date(2026, 7, 10);
      const to = new Date(2026, 7, 12);

      const stats = await readUsage(from, to);

      expect(stats.from).toBe(from.toISOString());
      expect(stats.to).toBe(to.toISOString());
    });

    it('treats an absent start as the ledger’s own first turn', async () => {
      const earliest = new Date(2026, 6, 1, 8);
      await record(earliest);
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(undefined, new Date(2026, 7, 11));

      expect(stats.from).toBe(earliest.toISOString());
      expect(stats.totals.turns).toBe(2);
    });

    it('falls back to a recent window when the ledger is empty', async () => {
      const to = new Date(2026, 7, 11);

      const stats = await readUsage(undefined, to);

      // Not the epoch: an empty ledger would otherwise open the page on a
      // fifty-year axis with nothing on it.
      expect(stats.days).toHaveLength(30);
      expect(stats.totals.turns).toBe(0);
    });

    it('clamps a start earlier than the ledger to the ledger’s own first turn', async () => {
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(
        new Date(1000, 0, 1),
        new Date(2026, 7, 11),
      );

      // The reply carries one bucket per calendar day in the RESOLVED range, so
      // an unclamped medieval start expands to ~375,000 buckets and a ~69MB
      // body — one authenticated request able to stall the loopback event loop.
      // Clamping to real data bounds the series by how long the app has been
      // recording, and the echoed range says the request was clamped.
      expect(new Date(stats.from).getFullYear()).toBe(2026);
      expect(stats.days.length).toBeLessThan(40);
      expect(stats.totals.turns).toBe(1);
    });

    it('clamps an end far in the FUTURE to now', async () => {
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(undefined, new Date(9999, 11, 31));

      // The mirror of the floor, and the one that was missed: clamping only the
      // lower bound left `?to=9999-12-31` resolving to ~2.9 million day buckets
      // and a ~511MB body — seven times the hole the floor was added to close.
      // Nothing is ever recorded in the future, so the ceiling is now.
      expect(new Date(stats.to).getFullYear()).toBeLessThan(9999);
      expect(stats.days.length).toBeLessThan(400);
    });

    it('answers an empty period for a window entirely in the future', async () => {
      await record(new Date(2026, 7, 10, 9));

      // Well-ordered bounds, both ahead of now — not a caller error, so it must
      // not 400 with "the start is after the end". The ledger simply holds
      // nothing there.
      const stats = await readUsage(
        new Date(3000, 0, 1),
        new Date(3000, 0, 31),
      );

      expect(stats.totals.turns).toBe(0);
      expect(stats.days).toEqual([]);
    });

    it('refuses an unparseable bound instead of matching nothing', async () => {
      await record(new Date(2026, 7, 10, 9));

      // Every comparison against an `Invalid Date` is false, so without the
      // guard this resolves to a period containing no turns — indistinguishable
      // on the page from a fortnight in which nothing was spent.
      await expect(service.usage('the tenth of August')).rejects.toThrow(
        /ISO-8601/,
      );
    });

    it('reports an empty period when the ledger starts after a lone end bound', async () => {
      await record(new Date(2026, 7, 10, 9));

      // The caller named ONE bound, and an absent start means "as far back as
      // the ledger goes" — so an end earlier than the ledger's first turn
      // describes a period in which nothing was spent, not a range the caller
      // got wrong. On an EMPTY ledger the very same request already answers
      // that way (the 30-day fallback), so today the same question is a 400 or
      // a 200 depending on data the caller cannot see.
      const stats = await service.usage(
        undefined,
        new Date(2026, 6, 1).toISOString(),
      );

      expect(stats.totals.turns).toBe(0);
    });

    it('refuses a range that ends before it starts', async () => {
      await expect(
        readUsage(new Date(2026, 7, 12), new Date(2026, 7, 10)),
      ).rejects.toThrow(/must not be after/);
    });
  });
});
