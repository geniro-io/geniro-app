import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { GoalDao } from '../../agents/dao/goal.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { ID_BATCH } from '../../agents/utils/id-batches';
import { Goal } from '../../runs/entity/goal.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { MemberAssessmentRecord } from '../entity/member-assessment.entity';
import { TeamRecommendation } from '../entity/team-recommendation.entity';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import type {
  MemberAssessmentRow,
  RunOutcomeLedgerRow,
  TeamVersionsWire,
  UsageEventInput,
} from '../stats.types';
import { POLLED_SPEND_SEQ } from '../stats.types';
import { TeamStatsService } from './team-stats.service';
import type { TeamVersionsService } from './team-versions.service';

describe('TeamStatsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let service: TeamStatsService;
  let liveChats: Set<string>;
  let versionTable: TeamVersionsWire | Error;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [
          UsageActivity,
          UsageEvent,
          ToolCallEvent,
          Goal,
          WallTurn,
          MemberAssessmentRecord,
          TeamRecommendation,
        ],
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
    activityDao = new UsageActivityDao(em);
    usageDao = new UsageEventDao(em);
    service = new TeamStatsService(
      em,
      activityDao,
      usageDao,
      new AgentAdapterRegistry([
        new ClaudeAdapter(),
        new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
      ]),
      new MetricLedgerDao(em),
      new GoalDao(em),
      new WallTurnDao(em),
      new MemberAssessmentDao(em),
      new TeamRecommendationDao(em),
      {
        getById: (id: string) =>
          Promise.resolve(liveChats.has(id) ? { id } : null),
      } as unknown as RunDao,
      {
        read: () =>
          versionTable instanceof Error
            ? Promise.reject(versionTable)
            : Promise.resolve(versionTable),
      } as unknown as TeamVersionsService,
    );
    liveChats = new Set();
    versionTable = {
      currentVersion: 'v2',
      versions: [
        { version: 'v2', ordinal: 2 },
        { version: 'v1', ordinal: 1 },
      ],
    } as unknown as TeamVersionsWire;
  });

  const started = new Date(2026, 9, 1, 10);

  async function teamRun(
    runId: string,
    slug = 'dev-team',
    at = started,
  ): Promise<void> {
    await activityDao.stampThreadVersion(runId, at, {
      slug,
      version: 'v1',
      inferred: false,
    });
  }

  let nextSeq = 0;
  async function turn(
    runId: string,
    overrides: Partial<UsageEventInput> = {},
  ): Promise<void> {
    nextSeq += 1;
    await usageDao.recordOnce({
      runId,
      memberId: 'lead',
      seq: nextSeq,
      occurredAt: started,
      agentKind: 'claude',
      model: null,
      cwd: null,
      teamName: 'Dev Team',
      costUsd: 1,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: 1000,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      ...overrides,
    });
  }

  function outcome(
    runId: string,
    prNumber: number,
    acceptance: RunOutcomeLedgerRow['acceptance'],
    occurredAt = started,
    teamSlug = 'dev-team',
  ): RunOutcomeLedgerRow {
    return {
      runId,
      sourceSeq: prNumber,
      occurredAt,
      teamSlug,
      prOwner: 'o',
      prRepo: 'r',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      draft: false,
      reviewRounds: 1,
      acceptance,
      questionsAsked: 0,
      changesRequestedRounds: null,
      msToAccepted: null,
    };
  }

  it('fills a turn no CLI timed with geniro’s clock, and says how much it measured', async () => {
    await teamRun('dev-1');
    await turn('dev-1', { durationMs: 1_000 });
    const timed = nextSeq;
    await turn('dev-1', {
      memberId: 'qa',
      agentKind: 'cursor-agent',
      costUsd: null,
      durationMs: null,
    });
    const untimed = nextSeq;
    await new WallTurnDao(orm.em.fork()).record('dev-1', [
      { seq: untimed, memberId: 'qa', ms: 60_000 },
      { seq: timed, memberId: 'lead', ms: 999_999 },
    ]);

    const stats = await service.read('dev-team');

    expect(stats.workedMs).toBe(61_000);
    expect(stats.measuredWorkedMs).toBe(60_000);
    expect(
      stats.byMember.find((member) => member.memberId === 'qa'),
    ).toMatchObject({
      workedMs: 60_000,
      measuredWorkedMs: 60_000,
    });
    expect(
      stats.byMember.find((member) => member.memberId === 'lead'),
    ).toMatchObject({ workedMs: 1_000, measuredWorkedMs: 0 });
  });

  it('counts every run of the team, not a page of them', async () => {
    const RUNS = ID_BATCH + 10;
    for (let i = 0; i < RUNS; i += 1) {
      await teamRun(`dev-${i}`);
      await turn(`dev-${i}`, { costUsd: 2, durationMs: 500 });
      await turn(`dev-${i}`, { costUsd: 1, durationMs: 500 });
    }
    await teamRun('ops-1', 'ops-team');
    await turn('ops-1', { costUsd: 50 });

    const stats = await service.read('dev-team');

    expect(stats.runs).toBe(RUNS);
    expect(stats.turns).toBe(RUNS * 2);
    expect(stats.costUsd).toBeCloseTo(RUNS * 3);
    expect(stats.workedMs).toBe(RUNS * 1000);
    expect(stats.byMember).toEqual([
      {
        memberId: 'lead',
        agentKind: 'claude',
        costUsd: expect.closeTo(RUNS * 3),
        turns: RUNS * 2,
        workedMs: RUNS * 1000,
        measuredWorkedMs: 0,
        runs: RUNS,
        work: null,
        assessments: [],
      },
    ]);
  });

  it('keeps unmeasured cost null', async () => {
    await teamRun('quiet');
    await turn('quiet', { costUsd: null, durationMs: null });

    const stats = await service.read('dev-team');

    expect(stats).toMatchObject({
      runs: 1,
      turns: 1,
      costUsd: null,
      estimatedCostUsd: null,
      workedMs: null,
    });
    expect(stats.days).toEqual([
      {
        day: '2026-10-01',
        runs: 1,
        costUsd: null,
        turns: 1,
        workedMs: null,
        outcomes: 0,
      },
    ]);
    expect(stats.byMember[0]).toMatchObject({ costUsd: null, workedMs: null });
  });

  it('reads a team with no runs as zeros and nulls', async () => {
    expect(await service.read('nobody')).toEqual({
      slug: 'nobody',
      runs: 0,
      costUsd: null,
      estimatedCostUsd: null,
      turns: 0,
      workedMs: null,
      measuredWorkedMs: 0,
      outcomes: {
        total: 0,
        accepted: 0,
        changesRequested: 0,
        notYet: 0,
        notNeeded: 0,
      },
      days: [],
      byMember: [],
      metrics: {
        goals: {
          recorded: 0,
          achieved: 0,
          notAchieved: 0,
          dropped: 0,
          open: 0,
          achievedShare: null,
          runsWithGoals: 0,
          measuredRuns: 0,
          coverage: null,
        },
        outcomes: {
          success: 0,
          partial: 0,
          failed: 0,
          abandoned: 0,
          recorded: 0,
          derived: 0,
        },
        handOffs: null,
        tools: [],
        mcpServers: [],
        stages: [],
        calls: [],
      },
    });
  });

  describe('thread metrics', () => {
    async function goal(
      runId: string,
      number: number,
      status: Goal['status'],
      teamSlug = 'dev-team',
    ): Promise<void> {
      const em = orm.em.fork();
      em.persist(
        Object.assign(new Goal(), {
          runId,
          number,
          teamSlug,
          text: `goal ${number}`,
          source: 'agent',
          status,
        }),
      );
      await em.flush();
    }

    it('reports goals achieved as achieved over every goal not dropped, an open one counted as not achieved', async () => {
      await teamRun('r1');
      await activityDao.markMetricsMeasured('r1');
      await teamRun('r2');
      await activityDao.markMetricsMeasured('r2');
      await goal('r1', 1, 'achieved');
      await goal('r1', 2, 'achieved');
      await goal('r1', 3, 'not_achieved');
      await goal('r2', 1, 'achieved');
      await goal('r2', 2, 'dropped');
      await goal('r2', 3, 'open');
      await goal('other-team-run', 1, 'not_achieved', 'other');

      const { metrics } = await service.read('dev-team');

      expect(metrics.goals).toEqual({
        recorded: 6,
        achieved: 3,
        notAchieved: 1,
        dropped: 1,
        open: 1,
        achievedShare: 0.6,
        runsWithGoals: 2,
        measuredRuns: 2,
        coverage: 1,
      });
      expect(metrics.outcomes).toMatchObject({
        partial: 1,
        success: 0,
        derived: 1,
      });
    });

    it('counts calls between members and hand-offs', async () => {
      await teamRun('r1');
      await activityDao.markMetricsMeasured('r1');
      const ledger = new MetricLedgerDao(orm.em);
      const call = (seq: number, caller: string, callee: string, ok: boolean) =>
        ledger.insertCall({
          runId: 'r1',
          seq,
          callId: `call-${seq}`,
          occurredAt: started,
          teamSlug: 'dev-team',
          caller,
          callee,
          durationMs: 1000 * seq,
          costUsd: 0.5,
          turns: 2,
          ok,
        });
      await call(1, 'lead', 'dev', true);
      await call(2, 'lead', 'dev', false);
      await call(3, 'dev', 'reviewer', true);
      for (const [seq, action] of [
        [10, 'handoff'],
        [11, 'complete'],
        [12, 'handoff'],
      ] as const) {
        await ledger.insertStage({
          runId: 'r1',
          seq,
          occurredAt: started,
          teamSlug: 'dev-team',
          memberId: null,
          lead: 'dev',
          stageId: 'build',
          action,
          enteredAt: null,
          durationMs: action === 'complete' ? 60_000 : null,
        });
      }

      const { metrics } = await service.read('dev-team');

      expect(metrics.calls).toEqual([
        {
          caller: 'lead',
          callee: 'dev',
          calls: 2,
          failed: 1,
          turns: 4,
          costUsd: 1,
          avgMs: 1500,
        },
        {
          caller: 'dev',
          callee: 'reviewer',
          calls: 1,
          failed: 0,
          turns: 2,
          costUsd: 0.5,
          avgMs: 3000,
        },
      ]);
      expect(metrics.handOffs).toBe(2);
      expect(metrics.stages).toEqual([
        {
          stageId: 'build',
          completed: 1,
          skipped: 0,
          reopened: 0,
          avgMs: 60_000,
        },
      ]);
    });

    it('keeps metrics of runs before the ledger null', async () => {
      await teamRun('old-run');

      const { metrics } = await service.read('dev-team');

      expect(metrics.goals.measuredRuns).toBe(0);
      expect(metrics.goals.coverage).toBeNull();
      expect(metrics.goals.achievedShare).toBeNull();
      expect(metrics.handOffs).toBeNull();
      expect(metrics.tools).toEqual([]);
    });
  });

  it('splits by member, most expensive first, and keeps memberless rows in the totals', async () => {
    await teamRun('r1');
    await turn('r1', { memberId: 'dev', costUsd: 1, durationMs: 100 });
    await turn('r1', {
      memberId: 'reviewer',
      costUsd: 4,
      durationMs: 300,
      agentKind: 'cursor-agent',
    });
    await turn('r1', {
      memberId: 'reviewer',
      costUsd: 2,
      durationMs: 200,
      agentKind: 'cursor-agent',
    });
    await turn('r1', { memberId: null, costUsd: 10, durationMs: 1000 });

    const stats = await service.read('dev-team');

    expect(stats.byMember).toEqual([
      {
        memberId: 'reviewer',
        agentKind: 'cursor-agent',
        costUsd: 6,
        turns: 2,
        workedMs: 500,
        measuredWorkedMs: 0,
        runs: 1,
        work: null,
        assessments: [],
      },
      {
        memberId: 'dev',
        agentKind: 'claude',
        costUsd: 1,
        turns: 1,
        workedMs: 100,
        measuredWorkedMs: 0,
        runs: 1,
        work: null,
        assessments: [],
      },
    ]);
    expect(stats.costUsd).toBe(17);
    expect(stats.turns).toBe(4);
    expect(stats.workedMs).toBe(1600);
  });

  it('counts polled spend in the totals and leaves a memberless row out of byMember', async () => {
    await teamRun('polled');
    await turn('polled', {
      memberId: 'dev',
      agentKind: 'cursor-agent',
      costUsd: null,
      durationMs: null,
    });
    await turn('polled', {
      memberId: null,
      seq: POLLED_SPEND_SEQ,
      agentKind: 'cursor-agent',
      costUsd: 7,
      durationMs: null,
    });

    const stats = await service.read('dev-team');

    expect(stats.costUsd).toBe(7);
    expect(stats.turns).toBe(1);
    expect(stats.byMember).toEqual([
      {
        memberId: 'dev',
        agentKind: 'cursor-agent',
        costUsd: null,
        turns: 1,
        workedMs: null,
        measuredWorkedMs: 0,
        runs: 1,
        work: null,
        assessments: [],
      },
    ]);
    expect(stats.days[0]).toMatchObject({ costUsd: 7, turns: 1 });
  });

  it('folds a daily series, oldest first, and counts a run whose chat is gone', async () => {
    const day1 = new Date(2026, 9, 1, 10);
    const day2 = new Date(2026, 9, 3, 10);
    await teamRun('gone', 'dev-team', day2);
    await teamRun('kept', 'dev-team', day1);
    await turn('gone', { occurredAt: day2, costUsd: 3, durationMs: 30 });
    await turn('kept', { occurredAt: day1, costUsd: 1, durationMs: 10 });
    await turn('kept', { occurredAt: day2, costUsd: 2, durationMs: 20 });
    await activityDao.upsertRunOutcome(outcome('kept', 1, 'accepted', day2));

    const stats = await service.read('dev-team');

    expect(stats.runs).toBe(2);
    expect(stats.days).toEqual([
      {
        day: '2026-10-01',
        runs: 1,
        costUsd: 1,
        turns: 1,
        workedMs: 10,
        outcomes: 0,
      },
      {
        day: '2026-10-03',
        runs: 1,
        costUsd: 5,
        turns: 2,
        workedMs: 50,
        outcomes: 1,
      },
    ]);
  });

  it('counts each pull request outcome of the team once, by acceptance', async () => {
    await teamRun('r1');
    await teamRun('r2');
    await teamRun('other', 'ops-team');
    await activityDao.upsertRunOutcome(outcome('r1', 1, 'accepted'));
    await activityDao.upsertRunOutcome(outcome('r1', 2, 'changes_requested'));
    await activityDao.upsertRunOutcome(outcome('r2', 3, 'not_yet'));
    await activityDao.upsertRunOutcome(outcome('r2', 4, 'not_needed'));
    await activityDao.upsertRunOutcome(
      outcome('other', 5, 'accepted', started, 'ops-team'),
    );

    const stats = await service.read('dev-team');

    expect(stats.outcomes).toEqual({
      total: 4,
      accepted: 1,
      changesRequested: 1,
      notYet: 1,
      notNeeded: 1,
    });
  });

  it('reports the part geniro priced', async () => {
    await teamRun('r1');
    await turn('r1', { costUsd: 3, estimatedCostUsd: 1 });
    await turn('r1', { costUsd: 2, estimatedCostUsd: null });

    const stats = await service.read('dev-team');

    expect(stats.costUsd).toBe(5);
    expect(stats.estimatedCostUsd).toBe(1);
  });
  describe('member work', () => {
    async function memberGoal(
      runId: string,
      number: number,
      memberId: string | null,
      status: Goal['status'],
    ): Promise<void> {
      const em = orm.em.fork();
      em.persist(
        Object.assign(new Goal(), {
          runId,
          number,
          teamSlug: 'dev-team',
          memberId,
          text: `goal ${number}`,
          source: 'agent',
          status,
        }),
      );
      await em.flush();
    }

    it("counts each member's calls, tool errors, goals and reopened completions over every measured run", async () => {
      const RUNS = ID_BATCH + 5;
      const ledger = new MetricLedgerDao(orm.em);
      for (let i = 0; i < RUNS; i += 1) {
        const runId = `r-${i}`;
        await teamRun(runId);
        await activityDao.markMetricsMeasured(runId);
        await turn(runId, { memberId: 'dev' });
        await ledger.insertCall({
          runId,
          seq: 1,
          callId: `call-${i}`,
          occurredAt: started,
          teamSlug: 'dev-team',
          caller: 'lead',
          callee: 'dev',
          durationMs: i === 0 ? null : 2_000,
          costUsd: null,
          turns: 1,
          ok: i !== 1,
        });
      }
      for (const [seq, ok] of [
        [10, true],
        [11, false],
        [12, false],
      ] as const) {
        await ledger.insertToolCall({
          runId: 'r-0',
          seq,
          occurredAt: started,
          teamSlug: 'dev-team',
          memberId: 'dev',
          agentKind: 'claude',
          tool: 'Bash',
          mcpServer: null,
          ok,
          durationMs: 10,
        });
      }
      for (const [seq, memberId, action] of [
        [20, 'dev', 'complete'],
        [21, 'reviewer', 'reopen'],
        [22, 'dev', 'complete'],
        [23, null, 'reopen'],
        [24, null, 'reopen'],
        [25, null, 'complete'],
        [26, 'reviewer', 'reopen'],
      ] as const) {
        await ledger.insertStage({
          runId: 'r-0',
          seq,
          occurredAt: started,
          teamSlug: 'dev-team',
          memberId,
          lead: null,
          stageId: 'build',
          action,
          enteredAt: null,
          durationMs: null,
        });
      }
      await memberGoal('r-0', 1, 'dev', 'achieved');
      await memberGoal('r-0', 2, 'dev', 'open');
      await memberGoal('r-0', 3, 'dev', 'dropped');
      await memberGoal('r-0', 4, null, 'not_achieved');

      const dev = (await service.read('dev-team')).byMember.find(
        (member) => member.memberId === 'dev',
      );

      expect(dev).toMatchObject({
        runs: RUNS,
        work: {
          measuredRuns: RUNS,
          callsAnswered: RUNS,
          callsFailed: 1,
          avgAnswerMs: 2_000,
          callsMade: 0,
          toolCalls: 3,
          toolErrors: 2,
          goals: {
            recorded: 3,
            achieved: 1,
            notAchieved: 0,
            open: 1,
            dropped: 1,
            achievedShare: 0.5,
          },
          stagesCompleted: 2,
          completionsReopened: 2,
        },
      });
    });

    it('keeps the work of a member the ledgers never watched null', async () => {
      await teamRun('old-run');
      await turn('old-run', { memberId: 'dev' });

      const [dev] = (await service.read('dev-team')).byMember;

      expect(dev).toMatchObject({ memberId: 'dev', runs: 1, work: null });
    });
  });

  describe('member assessments', () => {
    const assessment = (
      overrides: Partial<MemberAssessmentRow>,
    ): MemberAssessmentRow => ({
      slug: 'dev-team',
      chatRunId: 'analysis-1',
      chatKind: 'analysis',
      cardSeq: 5,
      filedAt: new Date('2026-10-20T10:00:00.000Z'),
      libraryVersion: 'v1',
      runs: 6,
      memberId: 'reviewer',
      usefulness: 3,
      quality: 2,
      verdict: 'tune',
      summary: 'Reviews are read, but it re-reads the diff every round',
      evidence: [{ runId: 'r1', seq: 4, quote: 'reading the diff again' }],
      items: [{ id: 'W-1', title: 'Review the diff once' }],
      ...overrides,
    });

    async function filed(
      chatRunId: string,
      itemId: string,
      fate: { selectedAt?: Date; outcome?: string },
    ): Promise<void> {
      const dao = new TeamRecommendationDao(orm.em.fork());
      await dao.file([
        {
          slug: 'dev-team',
          chatRunId,
          chatKind: 'analysis',
          cardSeq: 5,
          filedAt: new Date('2026-10-20T10:00:00.000Z'),
          libraryVersion: 'v1',
          itemId,
          target: 'team',
          territory: 'process',
          kind: 'instructions',
          location: 'reviewer',
          title: 'Review the diff once',
          change: 'x',
          rootCause: 'y',
          minutesSaved: 5,
          costSavedUsd: null,
          expectedOutcome: null,
          confidence: 3,
          risk: 'low',
        },
      ]);
      if (fate.selectedAt !== undefined) {
        await dao.markSelected(chatRunId, 5, [itemId], fate.selectedAt);
      }
      if (fate.outcome !== undefined) {
        await dao.markOutcome(
          chatRunId,
          5,
          { itemId, outcome: fate.outcome, note: null },
          { seq: 9, at: new Date('2026-10-21T10:00:00.000Z') },
        );
      }
    }

    it('lists every assessment of a member newest first, with its team version and what became of the items that carry it out', async () => {
      await teamRun('r1');
      await turn('r1', { memberId: 'reviewer' });
      await filed('analysis-1', 'W-1', {
        selectedAt: new Date('2026-10-20T11:00:00.000Z'),
        outcome: 'applied',
      });
      await filed('analysis-2', 'W-1', {});
      liveChats.add('analysis-2');
      await new MemberAssessmentDao(orm.em.fork()).file([
        assessment({}),
        assessment({
          chatRunId: 'analysis-2',
          filedAt: new Date('2026-10-25T10:00:00.000Z'),
          libraryVersion: 'v2',
          usefulness: 4,
          quality: 4,
        }),
        assessment({
          chatRunId: 'thread-1',
          chatKind: 'thread',
          filedAt: new Date('2026-10-26T10:00:00.000Z'),
          libraryVersion: 'v-gone',
          runs: 1,
          verdict: 'keep',
          items: [],
        }),
      ]);

      const reviewer = (await service.read('dev-team')).byMember.find(
        (member) => member.memberId === 'reviewer',
      );

      expect(
        reviewer?.assessments.map((entry) => [
          entry.chatRunId,
          entry.chatKind,
          entry.runs,
          entry.version,
          entry.usefulness,
          entry.quality,
          entry.items.map((item) => item.status),
        ]),
      ).toEqual([
        ['thread-1', 'thread', 1, { number: null, current: false }, 3, 2, []],
        [
          'analysis-2',
          'analysis',
          6,
          { number: 2, current: true },
          4,
          4,
          ['open'],
        ],
        [
          'analysis-1',
          'analysis',
          6,
          { number: 1, current: false },
          3,
          2,
          ['applied'],
        ],
      ]);
      expect(reviewer?.assessments[2]).toMatchObject({
        verdict: 'tune',
        summary: 'Reviews are read, but it re-reads the diff every round',
        evidence: [{ runId: 'r1', seq: 4, quote: 'reading the diff again' }],
        items: [{ id: 'W-1', title: 'Review the diff once' }],
      });
    });

    it('lists a member assessed but gone from the usage ledger, and names versions by nothing when the table cannot be read', async () => {
      versionTable = new Error('library unreadable');
      await new MemberAssessmentDao(orm.em.fork()).file([assessment({})]);

      const stats = await service.read('dev-team');

      expect(stats.byMember).toEqual([
        expect.objectContaining({
          memberId: 'reviewer',
          turns: 0,
          runs: 0,
          work: null,
          assessments: [
            expect.objectContaining({
              version: { number: null, current: false },
              items: [
                { id: 'W-1', title: 'Review the diff once', status: null },
              ],
            }),
          ],
        }),
      ]);
    });
  });
});
