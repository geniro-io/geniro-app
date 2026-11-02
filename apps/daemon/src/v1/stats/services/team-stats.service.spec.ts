import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { ID_BATCH } from '../../agents/utils/id-batches';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import type { RunOutcomeLedgerRow, UsageEventInput } from '../stats.types';
import { POLLED_SPEND_SEQ } from '../stats.types';
import { TeamStatsService } from './team-stats.service';

describe('TeamStatsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let service: TeamStatsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity, UsageEvent],
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
    );
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
      outcomes: {
        total: 0,
        accepted: 0,
        changesRequested: 0,
        notYet: 0,
        notNeeded: 0,
      },
      days: [],
      byMember: [],
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
      },
      {
        memberId: 'dev',
        agentKind: 'claude',
        costUsd: 1,
        turns: 1,
        workedMs: 100,
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
});
