import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { WorkflowChangeLogDao } from '../../graphs/dao/workflow-change-log.dao';
import { WorkflowChangeLogEntry } from '../../graphs/entity/workflow-change-log-entry.entity';
import type { Workflow } from '../../graphs/graphs.types';
import { WorkflowChangeLogService } from '../../graphs/services/workflow-change-log.service';
import type { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { WorkflowRecommendationDao } from '../dao/workflow-recommendation.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import { WorkflowRecommendation } from '../entity/workflow-recommendation.entity';
import { WorkflowVersion } from '../entity/workflow-version.entity';
import type { FiledRecommendation, UsageEventInput } from '../stats.types';
import { WorkflowHistoryService } from './workflow-history.service';
import { WorkflowVersionsService } from './workflow-versions.service';

const FIRST: Workflow = {
  name: 'Dev Team',
  nodes: [{ id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' }],
  edges: [],
};
const SECOND: Workflow = {
  ...FIRST,
  nodes: [{ ...FIRST.nodes[0]!, model: 'sonnet' } as Workflow['nodes'][number]],
};
const V1 = workflowVersionOf(FIRST);
const V2 = workflowVersionOf(SECOND);

/**
 * A workflow's history read from the ledgers alone: runs, chats and analyses
 * that are gone still count through what the ledgers kept.
 */
describe('WorkflowHistoryService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let versionDao: WorkflowVersionDao;
  let recommendations: WorkflowRecommendationDao;
  let changeLog: WorkflowChangeLogService;
  let liveRuns: Set<string>;
  let service: WorkflowHistoryService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [
          UsageActivity,
          UsageEvent,
          WorkflowVersion,
          WorkflowChangeLogEntry,
          WorkflowRecommendation,
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
    versionDao = new WorkflowVersionDao(em);
    recommendations = new WorkflowRecommendationDao(em);
    changeLog = new WorkflowChangeLogService(new WorkflowChangeLogDao(em));
    liveRuns = new Set(['analysis-new']);
    const adapters = {
      all: () => new Map(),
    } as unknown as AgentAdapterRegistry;
    service = new WorkflowHistoryService(
      em,
      new WorkflowVersionsService(
        em,
        activityDao,
        usageDao,
        versionDao,
        adapters,
        {
          get: () =>
            Promise.resolve({ slug: 'dev-team', workflow: SECOND, hash: 'h' }),
        } as unknown as WorkflowStoreService,
        changeLog,
      ),
      activityDao,
      usageDao,
      recommendations,
      changeLog,
      {
        getById: (id: string) =>
          Promise.resolve(liveRuns.has(id) ? { id } : null),
      } as unknown as RunDao,
      adapters,
    );
    for (const [workflow, version, at] of [
      [FIRST, V1, '2026-10-01T10:00:00.000Z'],
      [SECOND, V2, '2026-10-10T10:00:00.000Z'],
    ] as const) {
      await versionDao.register(
        'dev-team',
        version,
        canonicalGraphJson(canonicalGraphOf(workflow)),
        new Date(at),
      );
    }
  });

  async function workflowRun(
    runId: string,
    version: string,
    at: string,
    turns: { costUsd: number | null; durationMs: number | null }[],
  ): Promise<void> {
    await activityDao.stampThreadVersion(runId, new Date(at), {
      slug: 'dev-team',
      version,
      inferred: false,
    });
    for (const [index, turn] of turns.entries()) {
      const event: UsageEventInput = {
        runId,
        nodeId: 'dev',
        seq: index + 1,
        occurredAt: new Date(at),
        agentKind: 'claude',
        model: null,
        cwd: null,
        workflowName: 'Dev Team',
        costUsd: turn.costUsd,
        estimatedCostUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        durationMs: turn.durationMs,
        apiMs: null,
        ttftMs: null,
        timeToRequestMs: null,
        numTurns: null,
      };
      await usageDao.recordOnce(event);
    }
  }

  async function pullRequest(
    runId: string,
    acceptance: 'accepted' | 'changes_requested',
    reviewRounds: number,
    questionsAsked = 0,
  ): Promise<void> {
    await activityDao.upsertRunOutcome({
      runId,
      sourceSeq: 1,
      occurredAt: new Date('2026-10-11T10:00:00.000Z'),
      workflowSlug: 'dev-team',
      prOwner: 'acme',
      prRepo: 'app',
      prNumber: runId.length,
      prUrl: `https://github.com/acme/app/pull/${runId.length}`,
      draft: false,
      reviewRounds,
      acceptance,
      questionsAsked,
      changesRequestedRounds: acceptance === 'changes_requested' ? 1 : 0,
      msToAccepted: acceptance === 'accepted' ? 60_000 : null,
    });
  }

  function filed(
    chatRunId: string,
    cardSeq: number,
    itemId: string,
    filedAt: string,
  ): FiledRecommendation {
    return {
      slug: 'dev-team',
      chatRunId,
      chatKind: 'analysis',
      cardSeq,
      filedAt: new Date(filedAt),
      libraryVersion: V1,
      itemId,
      target: itemId.startsWith('W-') ? 'workflow' : 'repo',
      territory: 'process',
      kind: 'model',
      location: 'dev',
      title: `Title of ${itemId}`,
      change: 'x'.repeat(itemId === 'W-2' ? 1000 : 10),
      rootCause: 'the reviewer runs the largest model',
      minutesSaved: 5,
      confidence: 4,
      risk: 'low',
    };
  }

  it('folds every version over every run the ledgers kept, deleted runs included, newest version first', async () => {
    await workflowRun('run-a', V1, '2026-10-02T10:00:00.000Z', [
      { costUsd: 2, durationMs: 60_000 },
      { costUsd: 2, durationMs: 60_000 },
    ]);
    await workflowRun('run-b-deleted', V1, '2026-10-03T10:00:00.000Z', [
      { costUsd: 4, durationMs: 120_000 },
    ]);
    await workflowRun('run-c', V2, '2026-10-11T10:00:00.000Z', [
      { costUsd: 1, durationMs: 30_000 },
    ]);
    await pullRequest('run-a', 'changes_requested', 3);
    await pullRequest('run-c', 'accepted', 1, 2);

    const history = await service.read('dev-team', {
      analysedRunIds: ['run-c', 'run-a'],
      readerRunId: 'analysis-new',
    });

    expect(history.currentVersion).toEqual({
      version: V2,
      number: 2,
      current: true,
    });
    const [second, first] = history.versions;
    expect(second).toMatchObject({
      version: { version: V2, number: 2, current: true },
      analysedRunIds: ['run-c'],
      figures: {
        runs: 1,
        costUsd: 1,
        avgCostUsd: 1,
        turns: 1,
        cliWorkedMs: 30_000,
        avgCliWorkedMs: 30_000,
        pullRequests: {
          total: 1,
          accepted: 1,
          avgReviewRounds: 1,
          avgChangesRequestedRounds: 0,
          avgMsToAccepted: 60_000,
          avgQuestionsPerRun: 2,
        },
      },
    });
    expect(second!.changes!.diff).toContain('+    model: sonnet');
    expect(first).toMatchObject({
      version: { version: V1, number: 1, current: false },
      analysedRunIds: ['run-a'],
      figures: {
        runs: 2,
        pricedRuns: 2,
        costUsd: 8,
        avgCostUsd: 4,
        turns: 3,
        avgTurns: 1.5,
        cliWorkedMs: 240_000,
        avgCliWorkedMs: 120_000,
        pullRequests: {
          total: 1,
          changesRequested: 1,
          avgReviewRounds: 3,
          avgChangesRequestedRounds: 1,
          avgMsToAccepted: null,
          avgQuestionsPerRun: 0,
        },
      },
      changes: null,
    });
    expect(history.summary.analysedRunsByVersion).toEqual([
      { version: { version: V2, number: 2, current: true }, runIds: ['run-c'] },
      {
        version: { version: V1, number: 1, current: false },
        runIds: ['run-a'],
      },
    ]);
  });

  it('counts a run’s questions once whatever its pull requests, and leaves out copies made before questions were counted', async () => {
    await workflowRun('run-x', V1, '2026-10-02T10:00:00.000Z', [
      { costUsd: 1, durationMs: 60_000 },
    ]);
    await workflowRun('run-old', V1, '2026-10-01T10:00:00.000Z', [
      { costUsd: 1, durationMs: 60_000 },
    ]);
    const copy = (
      runId: string,
      prNumber: number,
      figures: {
        questionsAsked: number;
        changesRequestedRounds: number | null;
        msToAccepted: number | null;
      },
    ): Promise<void> =>
      activityDao.upsertRunOutcome({
        runId,
        sourceSeq: prNumber,
        occurredAt: new Date('2026-10-11T10:00:00.000Z'),
        workflowSlug: 'dev-team',
        prOwner: 'acme',
        prRepo: 'app',
        prNumber,
        prUrl: `https://github.com/acme/app/pull/${prNumber}`,
        draft: false,
        reviewRounds: 1,
        acceptance: 'accepted',
        ...figures,
      });
    await copy('run-x', 1, {
      questionsAsked: 2,
      changesRequestedRounds: 1,
      msToAccepted: 60_000,
    });
    await copy('run-x', 2, {
      questionsAsked: 5,
      changesRequestedRounds: 0,
      msToAccepted: 180_000,
    });
    await copy('run-old', 3, {
      questionsAsked: 0,
      changesRequestedRounds: null,
      msToAccepted: null,
    });

    const history = await service.read('dev-team', {
      analysedRunIds: ['run-x'],
      readerRunId: 'analysis-new',
    });

    expect(
      history.versions.find((entry) => entry.version?.version === V1)?.figures
        .pullRequests,
    ).toMatchObject({
      total: 3,
      accepted: 3,
      avgChangesRequestedRounds: 0.5,
      avgMsToAccepted: 120_000,
      avgQuestionsPerRun: 5,
    });
  });

  it('names who changed the workflow and why, and what became of every earlier recommendation, an analysis that is gone included', async () => {
    await recommendations.file([
      filed('analysis-old', 5, 'W-1', '2026-10-05T10:00:00.000Z'),
      filed('analysis-old', 5, 'W-2', '2026-10-05T10:00:00.000Z'),
      filed('analysis-old', 5, 'R-1', '2026-10-05T10:00:00.000Z'),
      filed('analysis-new', 3, 'W-1', '2026-10-12T10:00:00.000Z'),
    ]);
    const selectedAt = new Date('2026-10-05T11:00:00.000Z');
    await recommendations.markSelected(
      'analysis-old',
      5,
      ['W-1', 'R-1'],
      selectedAt,
    );
    await recommendations.markOutcome(
      'analysis-old',
      5,
      { itemId: 'W-1', outcome: 'applied', note: null },
      { seq: 9, at: new Date('2026-10-05T12:00:00.000Z') },
    );
    await recommendations.markOutcome(
      'analysis-old',
      5,
      { itemId: 'R-1', outcome: 'skipped', note: 'the check exists already' },
      { seq: 9, at: new Date('2026-10-05T12:00:00.000Z') },
    );
    await changeLog.record({
      slug: 'dev-team',
      source: 'analysis',
      before: FIRST,
      after: SECOND,
      summary: 'W-1 Title of W-1',
      recommendationIds: ['W-1'],
      chatRunId: 'analysis-old',
      cardSeq: 5,
      backup: '.backups/dev-team.yaml',
    });
    await changeLog.record({
      slug: 'dev-team',
      source: 'builder',
      before: SECOND,
      after: SECOND,
      reason: 'renamed it',
      chatRunId: 'analysis-new',
    });

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: 'analysis-new',
    });

    expect(history.changeLog.map((change) => change.source)).toEqual([
      'builder',
      'analysis',
    ]);
    expect(history.changeLog[1]).toMatchObject({
      from: { version: V1, number: 1, current: false },
      to: { version: V2, number: 2, current: true },
      summary: 'W-1 Title of W-1',
      recommendationIds: ['W-1'],
      chatRunId: 'analysis-old',
      byThisChat: false,
      backup: '.backups/dev-team.yaml',
    });
    expect(history.changeLog[0]).toMatchObject({ byThisChat: true });
    expect(history.versions[0]!.madeBy).toEqual([
      expect.objectContaining({ source: 'builder' }),
      expect.objectContaining({
        source: 'analysis',
        recommendationIds: ['W-1'],
      }),
    ]);

    const [newest, oldest] = history.recommendations;
    expect(newest).toMatchObject({
      chatRunId: 'analysis-new',
      byThisChat: true,
      chatStillExists: true,
      items: [{ id: 'W-1', status: 'open' }],
    });
    expect(oldest).toMatchObject({
      chatRunId: 'analysis-old',
      byThisChat: false,
      chatStillExists: false,
      cardSeq: 5,
      libraryVersion: { version: V1, number: 1 },
    });
    expect(
      oldest!.items.map(({ id, status, note }) => ({ id, status, note })),
    ).toEqual([
      { id: 'W-1', status: 'applied', note: null },
      { id: 'W-2', status: 'not-selected', note: null },
      { id: 'R-1', status: 'skipped', note: 'the check exists already' },
    ]);
    expect(oldest!.items[0]!.changedIn).toEqual([
      {
        at: history.changeLog[1]!.at,
        to: { version: V2, number: 2, current: true },
      },
    ]);
    expect(oldest!.items[0]!.selectedAt).toBe(selectedAt.toISOString());
    expect(oldest!.items[1]!.change).toMatch(/^x{600}… \[\+400 chars\]$/);
    expect(history.summary.recommendations).toEqual({
      applied: 1,
      skipped: 1,
      failed: 0,
      selected: 0,
      open: 1,
      'not-selected': 1,
    });
  });

  it('counts an item the user selected but nobody marked as selected', async () => {
    await recommendations.file([
      filed('analysis-old', 5, 'W-1', '2026-10-05T10:00:00.000Z'),
    ]);
    await recommendations.markSelected(
      'analysis-old',
      5,
      ['W-1'],
      new Date('2026-10-05T11:00:00.000Z'),
    );

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(history.recommendations[0]!.items[0]!.status).toBe('selected');
  });

  it("numbers each recorded version and names the library's current one", async () => {
    const index = await service.versionIndex('dev-team');

    expect(index.current).toBe(V2);
    expect([...index.numbers]).toEqual([
      [V2, 2],
      [V1, 1],
    ]);
  });
});
