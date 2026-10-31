import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../../memory/services/memory.service';
import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type {
  FoldedRun,
  ItemWire,
  RecommendationItem,
  RecommendationsPayload,
  RecommendationsReport,
  RunFold,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { AnalysisReportsService, checkItems } from './analysis-reports.service';
import type { ThreadReaderService } from './thread-reader.service';
import type { ThreadTimelineService } from './thread-timeline.service';

const CARD: RecommendationsPayload = {
  sourceRunId: 'source',
  sourceKind: 'workflow',
  timing: null,
  items: [
    {
      id: 'W-1',
      target: 'workflow',
      territory: 'process',
      kind: 'parallelize',
      location: 'reviewer',
      title: 'Parallel reviewers',
      change: 'edges: …',
      evidence: [{ seq: 4, quote: 'waiting' }],
      rootCause: 'serial',
      impact: { minutesSaved: 12, basis: 'critical path', confidence: 4 },
      risk: { level: 'low', note: 'none' },
    },
  ],
};

function sink(cardAt: number | null, card: unknown = CARD) {
  const written: { kind: string; payload: object }[] = [];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      rowAtSeq: (_runId: string, seq: number) =>
        Promise.resolve(
          seq === cardAt
            ? ({
                kind: 'recommendations',
                payload: JSON.stringify(card),
              } as Item)
            : null,
        ),
    } as unknown as ItemDao,
    {} as ThreadTimelineService,
    { enabled: true } as MemoryService,
    {} as ThreadReaderService,
  );
  return {
    written,
    mark: service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 20 } as ItemWire);
      },
    ).mark,
  };
}

describe('AnalysisReportsService — outcomes', () => {
  it('writes one outcome row against the card it names', async () => {
    const { mark, written } = sink(7);
    const marks = {
      cardSeq: 7,
      outcomes: [
        { id: 'W-1', status: 'applied' as const, backup: '.backups/x.yaml' },
      ],
    };

    expect(await mark(marks)).toEqual({
      status: 'recorded',
      seq: 20,
      count: 1,
    });
    expect(written).toEqual([
      { kind: 'recommendation_outcome', payload: marks },
    ]);
  });

  it('still marks a card whose stored figures no longer read', async () => {
    const { mark, written } = sink(7, {
      ...CARD,
      workflowStats: { runs: -1, agents: 'none' },
    });

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'recorded' });
    expect(written).toHaveLength(1);
  });

  it('refuses an id the card does not hold, and a seq that is not a card', async () => {
    const { mark, written } = sink(7);

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'R-4', status: 'failed' }] }),
    ).toEqual({ status: 'refused', reason: 'the card has no R-4' });
    expect(
      await mark({ cardSeq: 8, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'refused' });
    expect(written).toEqual([]);
  });
});

describe('checkItems', () => {
  const memoryItem = {
    ...CARD.items[0]!,
    id: 'M-1',
    target: 'memory' as const,
    kind: 'forget',
    location: 'm12',
  };

  it('caps memory items per target like any other', () => {
    const six = ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6'].map((id) => ({
      ...memoryItem,
      id,
    }));

    expect(
      checkItems(
        {
          hotspots: [],
          items: six.map((item) => ({
            ...item,
            impact: { ...item.impact, costSavedUsd: null, outcome: 'gone' },
          })),
        },
        'chat',
        true,
      ),
    ).toContain('6 memory items');
  });
});

const ITEM: RecommendationItem = {
  ...CARD.items[0]!,
  impact: {
    minutesSaved: 12,
    costSavedUsd: 0.4,
    basis: 'critical path',
    confidence: 4,
    outcome: 'reviewer 30m → 18m per run',
  },
};

function folded(runId: string): FoldedRun {
  return {
    runId,
    turns: [
      {
        nodeId: 'reviewer',
        startedAt: new Date(1_000).toISOString(),
        model: 'opus',
        member: null,
        outcome: 'completed',
        durationMs: 1_000,
        toolCalls: 1,
        inputTokens: null,
        outputTokens: null,
        costUsd: 2,
        contextTokens: null,
        timingSource: 'cli',
      },
    ],
    lanes: [
      {
        nodeId: 'reviewer',
        agentKind: 'claude',
        turns: 1,
        workedMs: 1_800_000,
        toolCalls: 1,
        costUsd: 2,
      },
    ],
    calls: [],
    wallWorkedMs: new Map(),
    callWorkedMs: new Map(),
    costUsd: 2,
    version: 'v-b',
    nodeModels: new Map(),
    pooledNodes: new Set(),
    timeline: {
      wallMs: 2_400_000,
      activeMs: 2_000_000,
      waitingOnUserMs: 0,
      criticalPathMs: 1_800_000,
      criticalPath: [],
      nodes: [],
      tools: [],
    },
  };
}

function workflowReporter() {
  const written: { kind: string; payload: object }[] = [];
  const runs = [
    { runId: 'r2', snapshotSeq: 30, working: false },
    { runId: 'r1', snapshotSeq: 20, working: false },
    { runId: 'gone', snapshotSeq: 10, working: false },
  ];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      existingSeqs: (_runId: string, seqs: number[]) =>
        Promise.resolve(new Set(seqs)),
    } as unknown as ItemDao,
    {} as ThreadTimelineService,
    { enabled: true } as MemoryService,
    {
      foldRuns: (analysed: typeof runs) =>
        Promise.resolve(
          analysed.map((entry): RunFold => ({
            analysed: entry,
            run:
              entry.runId === 'gone'
                ? null
                : ({
                    title: `Run ${entry.runId}`,
                    createdAt: new Date(entry.snapshotSeq * 1_000),
                  } as Run),
            folded: entry.runId === 'gone' ? null : folded(entry.runId),
          })),
        ),
    } as unknown as ThreadReaderService,
  );
  const report = service.sinkFor(
    {
      analysisRunId: 'analysis',
      sourceRunId: 'r2',
      snapshotSeq: 30,
      sourceWorking: false,
      workflow: { slug: 'dev-team', runs },
    },
    (kind, payload) => {
      written.push({ kind, payload });
      return Promise.resolve({ seq: 40 } as ItemWire);
    },
  ).report;
  return { written, report };
}

describe('AnalysisReportsService — a workflow card', () => {
  const index = () =>
    Promise.resolve({ current: 'v-b', numbers: new Map([['v-b', 3]]) });

  it("files the runs' figures the daemon measured beside the agent's hotspots, every run it read but a deleted one", async () => {
    const { report, written } = workflowReporter();
    const filed: RecommendationsReport = {
      hotspots: [
        {
          title: 'The reviewer holds every run',
          node: 'reviewer',
          why: 'It re-reads the whole diff each round',
          items: ['W-1'],
        },
      ],
      items: [ITEM],
    };

    expect(await report(filed, index)).toEqual({
      status: 'recorded',
      seq: 40,
      count: 1,
    });
    const payload = written[0]?.payload as RecommendationsPayload;
    expect(payload).toMatchObject({
      hotspots: filed.hotspots,
      timing: null,
      workflowStats: {
        runs: 2,
        perRun: { wallMs: 2_400_000, costUsd: 2, pricedRuns: 2 },
        totals: { costUsd: 4, turns: 2 },
        agents: [
          {
            node: 'reviewer',
            runs: 2,
            workedMs: 3_600_000,
            workedPerRunMs: 1_800_000,
            costPerRunUsd: 2,
          },
        ],
      },
    });
    expect(
      payload.workflowStats?.runList.map((run) => [
        run.runId,
        run.title,
        run.version,
        run.current,
      ]),
    ).toEqual([
      ['r2', 'Run r2', 3, true],
      ['r1', 'Run r1', 3, true],
    ]);
  });

  it('files the runs by hash alone when the version index cannot be read', async () => {
    const { report, written } = workflowReporter();

    await report({ hotspots: [], items: [ITEM] }, () =>
      Promise.reject(new Error('ledger locked')),
    );

    expect(
      (
        written[0]?.payload as RecommendationsPayload
      ).workflowStats?.runList.map((run) => run.version),
    ).toEqual([null, null]);
  });

  it('refuses a hotspot naming an item the card lacks, or a node that took no turn', async () => {
    const { report, written } = workflowReporter();

    expect(
      await report(
        {
          hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
          items: [ITEM],
        },
        index,
      ),
    ).toEqual({
      status: 'refused',
      reason: 'hotspot "Loops" names W-9, which is not on the card',
    });
    expect(
      await report(
        {
          hotspots: [{ title: 'Idle QA', node: 'qa', why: 'x', items: [] }],
          items: [ITEM],
        },
        index,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('node qa, which took no turn'),
    });
    expect(written).toEqual([]);
  });
});
