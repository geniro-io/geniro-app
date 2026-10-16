import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { RecommendationItem } from '../../../agents/chat.types';
import type { ItemDao } from '../../../agents/dao/item.dao';
import type { RunDao } from '../../../agents/dao/run.dao';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { AnalysisReportsService } from '../../../agents/services/analysis-reports.service';
import type { ThreadTimelineService } from '../../../agents/services/thread-timeline.service';
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
        : 'repo',
    kind: id.startsWith('W') ? 'parallelize' : 'check',
    location: id.startsWith('W') ? 'reviewer' : 'AGENTS.md:12',
    title: `Item ${id}`,
    change: 'the exact change',
    evidence: [{ seq, quote: 'waited for the reviewer' }],
    rootCause: 'serial calls',
    impact: { minutesSaved: 12, basis: 'critical path', confidence: 4 },
    risk: { level: 'low', note: 'nothing breaks' },
  };
}

function setup(workflowId: string | null) {
  const written: { kind: string; payload: unknown }[] = [];
  const reports = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      getById: () => Promise.resolve({ id: 'source', workflowId } as Run),
    } as unknown as RunDao,
    {
      existingSeqs: (_runId: string, seqs: number[], maxSeq: number) =>
        Promise.resolve(
          new Set(seqs.filter((seq) => seq <= maxSeq && seq !== 404)),
        ),
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
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 77 } as never);
      },
    ),
  );
  const report = (args: Record<string, unknown>) =>
    new ReportRecommendationsTool(analysis).call(
      'report_recommendations',
      args,
      CONTEXT,
    );
  return { report, written };
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

  it('refuses a workflow item when the analysed thread is a plain chat', async () => {
    const { report, written } = setup(null);

    const result = await report({ items: [item('W-1')] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      'only repo and user recommendations',
    );
    expect(written).toEqual([]);
  });

  it('takes a user-instructions item on a plain chat', async () => {
    const { report, written } = setup(null);

    const result = await report({ items: [item('R-1'), item('U-1')] });

    expect(result.isError).toBe(false);
    expect(written).toHaveLength(1);
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
