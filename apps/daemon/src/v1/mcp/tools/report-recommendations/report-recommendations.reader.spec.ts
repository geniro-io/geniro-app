import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type {
  AnalysedWorkflow,
  RecommendationItem,
} from '../../../agents/chat.types';
import type { ItemDao } from '../../../agents/dao/item.dao';
import type { RunDao } from '../../../agents/dao/run.dao';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { AnalysisReportsService } from '../../../agents/services/analysis-reports.service';
import type { ThreadTimelineService } from '../../../agents/services/thread-timeline.service';
import type { MemoryService } from '../../../memory/services/memory.service';
import type { Run } from '../../../runs/entity/run.entity';
import type { McpCallContext } from '../../mcp.types';
import { ReportRecommendationsTool } from './report-recommendations.tool';

const CONTEXT = {
  runId: 'analysis',
  nodeId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

function item(id: string, seq = 3): RecommendationItem {
  return {
    id,
    target: id.startsWith('W')
      ? 'workflow'
      : id.startsWith('U')
        ? 'user'
        : id.startsWith('M')
          ? 'memory'
          : 'repo',
    territory: 'process',
    kind: id.startsWith('W')
      ? 'parallelize'
      : id.startsWith('M')
        ? 'update'
        : 'check',
    location: id.startsWith('W')
      ? 'reviewer'
      : id.startsWith('M')
        ? 'm12'
        : 'AGENTS.md:12',
    title: `Item ${id}`,
    change: 'the exact change',
    evidence: [{ seq, quote: 'waited for the reviewer' }],
    rootCause: 'serial calls',
    impact: { minutesSaved: 12, basis: 'critical path', confidence: 4 },
    risk: { level: 'low', note: 'nothing breaks' },
  };
}

function setup(
  workflowId: string | null,
  workflow: AnalysedWorkflow | null = null,
  memoryOn = true,
) {
  const memory = { enabled: memoryOn } as MemoryService;
  const written: { kind: string; payload: unknown }[] = [];
  const checked: { runId: string; maxSeq: number }[] = [];
  const reports = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      // A workflow analysis needs no source row: its newest run may be gone.
      getById: () =>
        Promise.resolve(
          workflow === null ? ({ id: 'source', workflowId } as Run) : null,
        ),
    } as unknown as RunDao,
    {
      existingSeqs: (runId: string, seqs: number[], maxSeq: number) => {
        checked.push({ runId, maxSeq });
        return Promise.resolve(
          new Set(seqs.filter((seq) => seq <= maxSeq && seq !== 404)),
        );
      },
    } as unknown as ItemDao,
    {
      read: () =>
        Promise.resolve({
          fold: {},
          timeline: {
            wallMs: 600_000,
            activeMs: 400_000,
            waitingOnUserMs: 60_000,
            criticalPathMs: 500_000,
            sinks: [{ nodeId: 'reviewer', ms: 300_000 }],
          },
        }),
    } as unknown as ThreadTimelineService,
    memory,
  );
  const analysis = new AnalysisBroker();
  analysis.register(
    'analysis',
    'agent',
    reports.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 50,
        sourceWorking: false,
        workflow,
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 77 } as never);
      },
    ),
  );
  const tool = new ReportRecommendationsTool(analysis, memory);
  const report = (args: Record<string, unknown>) =>
    tool.call('report_recommendations', args, CONTEXT);
  const description = () => tool.list(CONTEXT)[0]?.description ?? '';
  return { report, description, written, checked };
}

describe('ReportRecommendationsTool', () => {
  it('persists a recommendations row with timing the daemon measured', async () => {
    const { report, written } = setup('dev-team');

    const result = await report({ items: [item('W-1'), item('R-1')] });

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('seq 77 with 2 recommendations');
    expect(written).toHaveLength(1);
    expect(written[0]!.kind).toBe('recommendations');
    expect(written[0]!.payload).toMatchObject({
      sourceRunId: 'source',
      sourceKind: 'workflow',
      timing: {
        wallMs: 600_000,
        criticalPathMs: 500_000,
        sinks: [{ label: 'reviewer', ms: 300_000 }],
      },
    });
  });

  it('refuses an evidence seq that does not exist, or lies past the snapshot', async () => {
    const { report, written } = setup('dev-team');

    const missing = await report({ items: [item('W-1', 404)] });
    const past = await report({ items: [item('W-1', 51)] });

    expect(missing.content[0]!.text).toContain('evidence seq 404');
    expect(past.content[0]!.text).toContain('evidence seq 51');
    expect(written).toEqual([]);
  });

  it("checks a workflow analysis's evidence against the run each quote names, at that run's snapshot", async () => {
    const { report, written, checked } = setup(null, {
      slug: 'team',
      runs: [
        { runId: 'source', snapshotSeq: 50, working: false },
        { runId: 'older', snapshotSeq: 8, working: false },
      ],
    });
    const cited = item('W-1');
    cited.evidence = [
      { seq: 3, quote: 'in the newest run' },
      { runId: 'older', seq: 7, quote: 'in an older run' },
    ];

    const result = await report({ items: [cited] });
    const past = await report({
      items: [
        { ...cited, evidence: [{ runId: 'older', seq: 9, quote: 'too late' }] },
      ],
    });
    const stranger = await report({
      items: [
        { ...cited, evidence: [{ runId: 'other', seq: 1, quote: 'not read' }] },
      ],
    });

    expect(result.isError).toBe(false);
    expect(checked.slice(0, 2)).toEqual([
      { runId: 'source', maxSeq: 50 },
      { runId: 'older', maxSeq: 8 },
    ]);
    expect(past.content[0]!.text).toContain(
      'evidence seq 9 does not exist in the analysed run older (snapshot ends at 8)',
    );
    expect(stranger.content[0]!.text).toContain(
      'evidence runId other is not one of the runs this analysis reads',
    );
    expect(written).toHaveLength(1);
    // One run's timing would pass for the workflow's.
    expect(written[0]!.payload).toMatchObject({
      sourceKind: 'workflow',
      timing: null,
    });
  });

  it('refuses a workflow item when the analysed thread is a plain chat', async () => {
    const { report, written } = setup(null);

    const result = await report({ items: [item('W-1')] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      'only repo, user and memory recommendations',
    );
    expect(written).toEqual([]);
  });

  it('takes a user-instructions item on a plain chat', async () => {
    const { report, written } = setup(null);

    const result = await report({ items: [item('R-1'), item('U-1')] });

    expect(result.isError).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('takes a memory item on a plain chat, and keeps its handle and kind', async () => {
    const { report, written } = setup(null);

    const result = await report({ items: [item('R-1'), item('M-1')] });

    expect(result.isError).toBe(false);
    expect(written[0]!.payload).toMatchObject({
      items: [
        { id: 'R-1', target: 'repo' },
        { id: 'M-1', target: 'memory', kind: 'update', location: 'm12' },
      ],
    });
  });

  it('offers and takes no memory item while the shared memory is off', async () => {
    const off = setup(null, null, false);
    const on = setup(null);

    const refused = await off.report({ items: [item('R-1'), item('M-1')] });

    expect(on.description()).toContain('M-1');
    expect(off.description()).not.toContain('M-1');
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('the shared memory is off');
    expect(off.written).toEqual([]);
  });

  it('refuses duplicate ids and an id whose prefix lies about its target', async () => {
    const { report } = setup('dev-team');

    expect(
      (await report({ items: [item('R-1'), item('R-1')] })).content[0]!.text,
    ).toContain('duplicate id R-1');
    expect(
      (await report({ items: [{ ...item('R-2'), target: 'workflow' }] }))
        .content[0]!.text,
    ).toContain('starts with W-');
    expect(
      (await report({ items: [{ ...item('R-3'), target: 'user' }] }))
        .content[0]!.text,
    ).toContain('starts with U-');
    expect(
      (await report({ items: [{ ...item('M-1'), target: 'repo' }] }))
        .content[0]!.text,
    ).toContain('starts with R-');
    expect(
      (await report({ items: [{ ...item('R-4'), target: 'memory' }] }))
        .content[0]!.text,
    ).toContain('starts with M-');
  });

  it('keeps each item to one territory: process or domain, named on the row', async () => {
    const { report, written } = setup('dev-team');
    const { territory: _omitted, ...untagged } = item('R-1');

    const missing = await report({ items: [untagged] });
    const mixed = await report({
      items: [{ ...item('R-1'), territory: 'process+domain' }],
    });
    const taken = await report({
      items: [item('W-1'), { ...item('R-1'), territory: 'domain' }],
    });

    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('territory');
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0]!.text).toContain('territory');
    expect(taken.isError).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0]!.payload).toMatchObject({
      items: [
        { id: 'W-1', territory: 'process' },
        { id: 'R-1', territory: 'domain' },
      ],
    });
  });

  it('refuses more than five items for one target', async () => {
    const { report, written } = setup('dev-team');

    const result = await report({
      items: ['W-1', 'W-2', 'W-3', 'W-4', 'W-5', 'W-6'].map((id) => item(id)),
    });

    expect(result.content[0]!.text).toContain('keep the strongest 5 at most');
    expect(written).toEqual([]);
  });

  it('takes five items for each target on one card', async () => {
    const { report, written } = setup('dev-team');
    const ids = [
      'W-1',
      'W-2',
      'W-3',
      'W-4',
      'W-5',
      'R-1',
      'R-2',
      'R-3',
      'R-4',
      'R-5',
      'U-1',
      'U-2',
      'U-3',
      'U-4',
      'U-5',
      'M-1',
      'M-2',
      'M-3',
      'M-4',
      'M-5',
    ];

    const result = await report({ items: ids.map((id) => item(id)) });

    expect(result.isError).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('records an empty report, and refuses a malformed item before it reaches the sink', async () => {
    const { report, written } = setup('dev-team');

    expect((await report({ items: [] })).isError).toBe(false);
    const malformed = await report({ items: [{ id: 'W-1' }] });
    expect(malformed.content[0]!.text).toMatch(/^INVALID_ARGS/);
    expect(written).toHaveLength(1);
  });
});
