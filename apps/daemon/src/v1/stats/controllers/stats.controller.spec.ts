import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Run } from '../../runs/entity/run.entity';
import { metricLedgerDb } from '../__tests__/metric-ledger-db';
import {
  restoreTeamVersionSchema,
  teamStatsParamsSchema,
  teamVersionsQuerySchema,
} from '../dto/stats.dto';
import type { StatsService } from '../services/stats.service';
import type { TeamStatsService } from '../services/team-stats.service';
import type { TeamVersionsService } from '../services/team-versions.service';
import type { ToolCallLogRetentionService } from '../services/tool-call-log-retention.service';
import type { ToolUsageService } from '../services/tool-usage.service';
import type {
  TeamStatsWire,
  TeamVersionRestoredWire,
  TeamVersionsWire,
  UsageStatsWire,
} from '../stats.types';
import {
  ToolUsageConfigSchema,
  ToolUsageSubjectQuerySchema,
} from '../stats.types';
import { StatsController } from './stats.controller';

describe('StatsController', () => {
  const answer = { totals: { turns: 0 } } as unknown as UsageStatsWire;

  function controller(): {
    route: StatsController;
    usage: ReturnType<typeof vi.fn>;
  } {
    const usage = vi.fn(async () => answer);
    return {
      route: new StatsController(
        { usage } as unknown as StatsService,
        {} as TeamVersionsService,
        {} as TeamStatsService,
        {} as ToolUsageService,
        {} as ToolCallLogRetentionService,
      ),
      usage,
    };
  }

  it('passes both bounds through to the service', async () => {
    const { route, usage } = controller();
    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-08-15T00:00:00.000Z';

    await expect(route.readUsage({ from, to })).resolves.toBe(answer);

    expect(usage).toHaveBeenCalledWith(from, to);
  });

  it('forwards an omitted bound as undefined rather than substituting one', async () => {
    const { route, usage } = controller();

    await route.readUsage({});

    // The service owns what an absent bound MEANS ("as far back as the ledger
    // goes" / "up to now"); a default invented here would put that decision in
    // two places and let them disagree.
    expect(usage).toHaveBeenCalledWith(undefined, undefined);
  });

  describe('readTeamVersions', () => {
    it('hands the slug to the versions service and answers what it read', async () => {
      const versions = {
        slug: 'dev-team',
      } as unknown as TeamVersionsWire;
      const read = vi.fn(async () => versions);
      const route = new StatsController(
        {} as StatsService,
        { read } as unknown as TeamVersionsService,
        {} as TeamStatsService,
        {} as ToolUsageService,
        {} as ToolCallLogRetentionService,
      );

      await expect(route.readTeamVersions({ slug: 'dev-team' })).resolves.toBe(
        versions,
      );
      expect(read).toHaveBeenCalledWith('dev-team');
    });

    it.each(['', '../etc', 'has space', '-leading-dash'])(
      'refuses the slug %j before it reaches the service',
      (slug) => {
        expect(teamVersionsQuerySchema.safeParse({ slug }).success).toBe(false);
      },
    );

    it('refuses a request with no slug', () => {
      expect(teamVersionsQuerySchema.safeParse({}).success).toBe(false);
    });

    it('accepts a library slug', () => {
      expect(
        teamVersionsQuerySchema.safeParse({ slug: 'dev-team_2' }).success,
      ).toBe(true);
    });
  });

  describe('readTeamStats', () => {
    it('hands the slug to the team stats service and answers what it read', async () => {
      const stats = { slug: 'dev-team' } as TeamStatsWire;
      const read = vi.fn(async () => stats);
      const route = new StatsController(
        {} as StatsService,
        {} as TeamVersionsService,
        { read } as unknown as TeamStatsService,
        {} as ToolUsageService,
        {} as ToolCallLogRetentionService,
      );

      await expect(route.readTeamStats({ slug: 'dev-team' })).resolves.toBe(
        stats,
      );
      expect(read).toHaveBeenCalledWith('dev-team');
    });

    it.each(['', '../etc', 'has space'])(
      'refuses the slug %j before it reaches the service',
      (slug) => {
        expect(teamStatsParamsSchema.safeParse({ slug }).success).toBe(false);
      },
    );
  });

  describe('restoreTeamVersion', () => {
    it('hands the slug, version and base hash to the versions service', async () => {
      const answer = { slug: 'dev-team' } as TeamVersionRestoredWire;
      const restore = vi.fn(async () => answer);
      const route = new StatsController(
        {} as StatsService,
        { restore } as unknown as TeamVersionsService,
        {} as TeamStatsService,
        {} as ToolUsageService,
        {} as ToolCallLogRetentionService,
      );

      await expect(
        route.restoreTeamVersion({
          slug: 'dev-team',
          version: '0123456789abcdef',
          baseHash: 'h1',
        }),
      ).resolves.toBe(answer);
      expect(restore).toHaveBeenCalledWith(
        'dev-team',
        '0123456789abcdef',
        'h1',
      );
    });

    it.each([
      { slug: '../etc', version: '0123456789abcdef' },
      { slug: 'dev-team', version: 'not-a-version' },
      { slug: 'dev-team', version: '0123456789ABCDEF' },
      { slug: 'dev-team' },
    ])('refuses %j before it reaches the service', (body) => {
      expect(restoreTeamVersionSchema.safeParse(body).success).toBe(false);
    });
  });
});

describe('StatsController — tool usage', () => {
  let db: Awaited<ReturnType<typeof metricLedgerDb>>;
  let route: StatsController;

  beforeEach(async () => {
    db = await metricLedgerDb();
    route = new StatsController(
      {} as StatsService,
      {} as TeamVersionsService,
      {} as TeamStatsService,
      db.toolUsage,
      db.retention,
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  it('counts every subject and every call, past any page and from runs deleted since', async () => {
    await db.seedRun('r1', { agentKind: 'claude' });
    for (let i = 0; i < 30; i += 1) {
      await db.feed(
        'r1',
        'tool_call',
        { id: `c${i}`, name: `tool_${i}` },
        '2026-11-01T10:00:00.000Z',
      );
      await db.feed(
        'r1',
        'tool_result',
        { id: `c${i}`, isError: false },
        '2026-11-01T10:00:01.000Z',
      );
    }
    await db.feed(
      'r1',
      'tool_call',
      { id: 'again', name: 'tool_29' },
      '2026-11-01T10:01:00.000Z',
    );
    await db.feed(
      'r1',
      'tool_result',
      { id: 'again', isError: true },
      '2026-11-01T10:01:01.000Z',
    );
    await db.em.fork().nativeDelete(Run, { id: 'r1' });
    db.bus.publishRunDeleted('r1');

    const brief = await route.readToolUsage();

    expect(brief.rows).toHaveLength(30);
    expect(brief.rows[0]).toMatchObject({
      subject: 'tool_29',
      calls: 2,
      errors: 1,
    });
    expect(brief.rows.reduce((sum, row) => sum + row.calls, 0)).toBe(31);
  });

  it('lists a Geniro tool this build serves and nobody called under never called, at zero', async () => {
    await db.registry.registerGeniroTools(['note_thread']);

    const brief = await route.readToolUsage();

    expect(brief.neverCalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'note_thread',
          source: 'geniro',
          calls: 0,
        }),
      ]),
    );
  });

  it("answers one subject's split", async () => {
    await db.seedRun('r2', { agentKind: 'codex' });
    await db.feed(
      'r2',
      'tool_call',
      { id: 'x', name: 'shell', toolKind: 'execute' },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      'r2',
      'tool_result',
      { id: 'x', isError: false },
      '2026-11-01T10:00:01.000Z',
    );

    const subject = await route.readToolUsageSubject({
      subjectKind: 'tool',
      subject: 'shell',
      source: '',
    });

    expect(subject.row).toMatchObject({ calls: 1 });
    expect(subject.byAgent).toEqual([
      { agentKind: 'codex', calls: 1, errors: 0 },
    ]);
  });

  it('dates the counting from the oldest folded use, and live counting from the cutoff', async () => {
    await db.backfill.onModuleInit();
    const cutoff = db.backfill.cutoff ?? 0;
    const brief = await route.readToolUsage();
    expect(brief.countingSince).toBe(new Date(cutoff).toISOString());

    await db.counterDao.add([
      {
        subjectKind: 'tool',
        subject: 'Read',
        source: '',
        agentKind: 'claude',
        origin: 'direct',
        projectId: '',
        calls: 1,
        errors: 0,
        refused: 0,
        durationMsTotal: 0,
        timedCalls: 0,
        resultCharsTotal: 0,
        sizedCalls: 0,
        offeredSessions: 0,
        firstAt: 1_000,
        lastAt: 1_000,
      },
    ]);

    expect(await route.readToolUsage()).toMatchObject({
      countingSince: new Date(1_000).toISOString(),
      liveSince: new Date(cutoff).toISOString(),
    });
  });

  it('hands the pushed retention to the sweep and answers it back', () => {
    expect(route.setToolUsageConfig({ toolCallLogRetentionDays: 30 })).toEqual({
      toolCallLogRetentionDays: 30,
    });
    expect(db.retention.configured).toBe(30);
  });

  it.each([
    { toolCallLogRetentionDays: 0 },
    { toolCallLogRetentionDays: 3651 },
    { toolCallLogRetentionDays: 1.5 },
  ])('refuses the retention %j', (body) => {
    expect(ToolUsageConfigSchema.safeParse(body).success).toBe(false);
  });

  it('refuses a subject query with no name', () => {
    expect(
      ToolUsageSubjectQuerySchema.safeParse({ subjectKind: 'tool' }).success,
    ).toBe(false);
  });
});
