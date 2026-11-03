import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type {
  FoldedRun,
  ItemWire,
  MemberAssessment,
  RecommendationItem,
  RecommendationsPayload,
  RecommendationsReport,
  RunFold,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import {
  AnalysisReportsService,
  checkItems,
  checkMembers,
} from './analysis-reports.service';
import type { ThreadReaderService } from './thread-reader.service';
import type { ThreadTimelineService } from './thread-timeline.service';

const CARD: RecommendationsPayload = {
  sourceRunId: 'source',
  sourceKind: 'team',
  timing: null,
  items: [
    {
      id: 'W-1',
      target: 'team',
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
    {} as ProjectScopeService,
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
      teamStats: { runs: -1, agents: 'none' },
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
        new Set(),
      ),
    ).toContain('6 memory items');
  });

  const projectItem = {
    ...CARD.items[0]!,
    id: 'P-1',
    target: 'project' as const,
    kind: 'update',
    location: 'p-billing',
    impact: {
      ...CARD.items[0]!.impact,
      costSavedUsd: null,
      outcome: 'fewer retries',
    },
  };

  it('takes a P- item naming an analysed run’s project, in a chat analysis too', () => {
    expect(
      checkItems(
        { hotspots: [], items: [projectItem] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toBeNull();
  });

  it('refuses a P- item naming another project, and any when no analysed run has one', () => {
    expect(
      checkItems(
        { hotspots: [], items: [{ ...projectItem, location: 'p-other' }] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toContain('location must be the projectId');
    expect(
      checkItems(
        { hotspots: [], items: [projectItem] },
        'team',
        true,
        new Set(),
      ),
    ).toContain('belong to no project');
  });

  const overlayItem = { ...projectItem, id: 'O-1', target: 'overlay' as const };

  it('takes an O- item naming an analysed team run’s project', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(['p-billing']),
      ),
    ).toBeNull();
  });

  it('refuses an O- item for a plain chat, for another project, and when no analysed run has one', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toContain('no team overlay to change');
    expect(
      checkItems(
        { hotspots: [], items: [{ ...overlayItem, location: 'p-other' }] },
        'team',
        true,
        new Set(['p-billing']),
      ),
    ).toContain('location must be the projectId whose overlay it changes');
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(),
      ),
    ).toContain('overlay recommendations cannot apply');
  });

  it('refuses an O- item for a project that defaults to another team', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(['p-billing']),
        new Set(),
      ),
    ).toContain('defaults to another team');
  });
});

describe('AnalysisReportsService — project items', () => {
  it('refuses a P- item for a project outside the analysed runs', async () => {
    const written: unknown[] = [];
    const service = new AnalysisReportsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: (id: string) =>
          Promise.resolve({ id, teamId: null, projectId: 'p-billing' } as Run),
      } as unknown as RunDao,
      {} as ItemDao,
      {} as ThreadTimelineService,
      { enabled: true } as MemoryService,
      {} as ThreadReaderService,
      {
        projectOfRun: (run: Pick<Run, 'projectId'>) =>
          Promise.resolve(run.projectId ? { id: run.projectId } : null),
      } as unknown as ProjectScopeService,
    );
    const { report } = service.sinkFor(
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
    );

    expect(
      await report(
        {
          hotspots: [],
          items: [
            {
              ...CARD.items[0]!,
              id: 'P-1',
              target: 'project',
              kind: 'update',
              location: 'p-shop',
              impact: {
                ...CARD.items[0]!.impact,
                costSavedUsd: null,
                outcome: 'fewer retries',
              },
            },
          ],
        },
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('(p-billing)'),
    });
    expect(written).toEqual([]);
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
        memberId: 'reviewer',
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
        memberId: 'reviewer',
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

const REVIEWER: MemberAssessment = {
  member: 'reviewer',
  usefulness: 4,
  quality: 2,
  verdict: 'tune',
  summary: 'Its reviews are used, but it re-reads the whole diff every round',
  evidence: [{ runId: 'r1', seq: 7, quote: 'reading the diff again' }],
  items: ['W-1'],
};

function teamReporter(existing?: (runId: string, seqs: number[]) => number[]) {
  const written: { kind: string; payload: object }[] = [];
  const asked: { runId: string; seqs: number[] }[] = [];
  const runs = [
    { runId: 'r2', snapshotSeq: 30, working: false },
    { runId: 'r1', snapshotSeq: 20, working: false },
    { runId: 'gone', snapshotSeq: 10, working: false },
  ];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      existingSeqs: (runId: string, seqs: number[]) => {
        asked.push({ runId, seqs });
        return Promise.resolve(new Set(existing?.(runId, seqs) ?? seqs));
      },
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
    {} as ProjectScopeService,
  );
  const report = service.sinkFor(
    {
      analysisRunId: 'analysis',
      sourceRunId: 'r2',
      snapshotSeq: 30,
      sourceWorking: false,
      team: { slug: 'dev-team', runs },
    },
    (kind, payload) => {
      written.push({ kind, payload });
      return Promise.resolve({ seq: 40 } as ItemWire);
    },
  ).report;
  return { written, report, asked };
}

describe('AnalysisReportsService — a team card', () => {
  const index = () =>
    Promise.resolve({ current: 'v-b', numbers: new Map([['v-b', 3]]) });

  it("files the runs' figures the daemon measured beside the agent's hotspots, every run it read but a deleted one", async () => {
    const { report, written } = teamReporter();
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
      members: [REVIEWER],
    };

    expect(await report(filed, index)).toEqual({
      status: 'recorded',
      seq: 40,
      count: 1,
      members: 1,
    });
    const payload = written[0]?.payload as RecommendationsPayload;
    expect(payload).toMatchObject({
      hotspots: filed.hotspots,
      members: [REVIEWER],
      timing: null,
      teamStats: {
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
      payload.teamStats?.runList.map((run) => [
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
    const { report, written } = teamReporter();

    await report({ hotspots: [], items: [ITEM], members: [REVIEWER] }, () =>
      Promise.reject(new Error('ledger locked')),
    );

    expect(
      (written[0]?.payload as RecommendationsPayload).teamStats?.runList.map(
        (run) => run.version,
      ),
    ).toEqual([null, null]);
  });

  it('refuses a hotspot naming an item the card lacks, or a member that took no turn', async () => {
    const { report, written } = teamReporter();

    expect(
      await report(
        {
          hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
          items: [ITEM],
          members: [REVIEWER],
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
          members: [REVIEWER],
        },
        index,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('member qa, which took no turn'),
    });
    expect(written).toEqual([]);
  });
});

describe('AnalysisReportsService — member assessments', () => {
  const index = () =>
    Promise.resolve({ current: 'v-b', numbers: new Map([['v-b', 3]]) });

  it('refuses a team card that assesses no member', async () => {
    const { report, written } = teamReporter();

    expect(await report({ hotspots: [], items: [ITEM] }, index)).toEqual({
      status: 'refused',
      reason:
        'assess the members: one entry in members for each member of the team that took a turn in the analysed runs',
    });
    expect(written).toEqual([]);
  });

  it("checks a member's evidence against the run it names", async () => {
    const { report, written, asked } = teamReporter((runId, seqs) =>
      runId === 'r1' ? seqs.filter((seq) => seq !== 7) : seqs,
    );

    expect(
      await report({ hotspots: [], items: [ITEM], members: [REVIEWER] }, index),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('evidence seq 7 does not exist'),
    });
    expect(asked).toContainEqual({ runId: 'r1', seqs: [7] });
    expect(written).toEqual([]);
  });

  it('refuses a member that took no turn in the analysed runs', async () => {
    const { report, written } = teamReporter();

    expect(
      await report(
        {
          hotspots: [],
          items: [ITEM],
          members: [REVIEWER, { ...REVIEWER, member: 'qa' }],
        },
        index,
      ),
    ).toEqual({
      status: 'refused',
      reason:
        'member qa took no turn in the analysed runs — assess only members the reads name (reviewer)',
    });
    expect(written).toEqual([]);
  });

  it("assesses a thread analysis of a team run by the run's own lanes", async () => {
    const written: object[] = [];
    const service = new AnalysisReportsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: () => Promise.resolve({ id: 'source', teamId: 'dev-team' }),
      } as unknown as RunDao,
      {
        existingSeqs: (_runId: string, seqs: number[]) =>
          Promise.resolve(new Set(seqs)),
      } as unknown as ItemDao,
      {
        read: () =>
          Promise.resolve({
            fold: { lanes: [{ memberId: 'reviewer' }, { memberId: 'coder' }] },
            timeline: { ...folded('source').timeline, sinks: [] },
          }),
      } as unknown as ThreadTimelineService,
      { enabled: true } as MemoryService,
      {} as ThreadReaderService,
      {} as ProjectScopeService,
    );
    const { report } = service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      (_kind, payload) => {
        written.push(payload);
        return Promise.resolve({ seq: 12 } as ItemWire);
      },
    );
    const coder: MemberAssessment = {
      ...REVIEWER,
      member: 'coder',
      verdict: 'keep',
      items: [],
      evidence: [{ seq: 3, quote: 'tests pass' }],
    };

    expect(
      await report(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, evidence: [{ seq: 4, quote: 'x' }] }, coder],
        },
        null,
      ),
    ).toEqual({ status: 'recorded', seq: 12, count: 1, members: 2 });
    expect(
      await report(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...coder, member: 'qa' }],
        },
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('(reviewer, coder)'),
    });
    expect(written).toHaveLength(1);
    expect((written[0] as RecommendationsPayload).members).toHaveLength(2);
  });
});

describe('checkMembers', () => {
  const took = new Set(['reviewer', 'coder']);
  const repoItem: RecommendationItem = {
    ...ITEM,
    id: 'R-1',
    target: 'repo',
    kind: 'check',
    location: 'package.json:1',
  };

  it('takes a chat with no members, and refuses one that assesses any', () => {
    expect(checkMembers({ hotspots: [], items: [] }, 'chat', took)).toBeNull();
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER] },
        'chat',
        took,
      ),
    ).toContain('plain chat');
  });

  it('refuses a member assessed twice', () => {
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER, REVIEWER] },
        'team',
        took,
      ),
    ).toBe('member reviewer is assessed twice — one entry per member');
  });

  it('refuses a verdict carried out by an item the card lacks, or by a non-team item', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, items: ['W-2'] }],
        },
        'team',
        took,
      ),
    ).toBe('member reviewer names W-2, which is not on the card');
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM, repoItem],
          members: [{ ...REVIEWER, items: ['R-1'] }],
        },
        'team',
        took,
      ),
    ).toContain("only team items (W-…) carry out a member's verdict");
  });

  it('takes a member the runs gave too little to judge, but refuses a change resting on no mark', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [
            {
              ...REVIEWER,
              usefulness: null,
              quality: null,
              verdict: 'keep',
              items: [],
            },
          ],
        },
        'team',
        took,
      ),
    ).toBeNull();
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, usefulness: null, quality: null }],
        },
        'team',
        took,
      ),
    ).toBe(
      "member reviewer's verdict tune rests on no mark — judge its usefulness or quality, or keep it while the runs give too little to judge",
    );
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, usefulness: null }],
        },
        'team',
        took,
      ),
    ).toBeNull();
  });

  it('refuses a change with no item to carry it out, and a keep that names one', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, verdict: 'remove', items: [] }],
        },
        'team',
        took,
      ),
    ).toContain('verdict remove names no item');
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, verdict: 'keep' }],
        },
        'team',
        took,
      ),
    ).toContain('is kept, so it names no items');
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER] },
        'team',
        took,
      ),
    ).toBeNull();
  });
});
