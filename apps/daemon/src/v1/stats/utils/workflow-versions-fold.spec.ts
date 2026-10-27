import { describe, expect, it } from 'vitest';

import type { RunFacts } from '../../agents/chat.types';
import type { Workflow } from '../../graphs/graphs.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
import { POLLED_SPEND_SEQ, type ThreadLedgerRow } from '../stats.types';
import {
  foldWorkflowVersions,
  type UsageLedgerRow,
  versionChangesOf,
  type WorkflowVersionsInput,
} from './workflow-versions-fold';

const v1: Workflow = {
  name: 'Dev Team',
  maxActiveTurns: 2,
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'dev',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      name: 'Developer',
    },
  ],
  edges: [{ from: 'start', to: 'dev', kind: 'data' }],
};
const v2: Workflow = {
  ...v1,
  maxActiveTurns: 3,
  nodes: [
    ...v1.nodes.map((node) =>
      node.id === 'dev' ? { ...node, role: 'Write the code' } : node,
    ),
    {
      id: 'qa',
      kind: 'agent',
      agent: 'cursor-agent',
      approval: 'auto',
      name: 'QA',
    },
  ],
  edges: [...v1.edges, { from: 'dev', to: 'qa', kind: 'call' }],
};
const V1 = workflowVersionOf(v1);
const V2 = workflowVersionOf(v2);

const graphs = [
  {
    version: V1,
    graph: canonicalGraphJson(canonicalGraphOf(v1)),
    firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  },
  {
    version: V2,
    graph: canonicalGraphJson(canonicalGraphOf(v2)),
    firstSeenAt: new Date('2026-10-01T00:00:00Z'),
  },
];

function thread(
  runId: string,
  version: string | null,
  occurredAt: string,
  stamp: Partial<ThreadLedgerRow> = {},
): ThreadLedgerRow {
  return {
    runId,
    occurredAt: new Date(occurredAt),
    slug: 'dev-team',
    version,
    inferred: version === null ? null : false,
    runStatus: null,
    failedNodes: null,
    ...stamp,
  };
}

function live(
  id: string,
  status: RunFacts['status'],
  title = id,
): [string, RunFacts] {
  return [
    id,
    { id, workflowId: 'dev-team', status, title, createdAt: new Date(0) },
  ];
}

function turn(
  runId: string,
  seq: number,
  figures: Partial<UsageLedgerRow> = {},
): UsageLedgerRow {
  return {
    runId,
    seq,
    agentKind: 'claude',
    costUsd: 1,
    estimatedCostUsd: null,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    durationMs: 1000,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
    ...figures,
  };
}

function input(
  overrides: Partial<WorkflowVersionsInput>,
): WorkflowVersionsInput {
  return {
    slug: 'dev-team',
    currentVersion: V2,
    threads: [],
    live: new Map(),
    usage: [],
    polledKinds: ['cursor-agent'],
    liveFailedNodes: new Map(),
    graphs,
    ...overrides,
  };
}

describe('foldWorkflowVersions', () => {
  it('groups runs by version and sums each group to the workflow total, a run years old included', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('ancient', V1, '2021-01-01T00:00:00Z'),
          thread('a', V1, '2026-09-02T00:00:00Z'),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('c', V2, '2026-10-03T00:00:00Z'),
        ],
        live: new Map([
          live('ancient', 'completed'),
          live('a', 'completed'),
          live('b', 'failed'),
          live('c', 'completed'),
        ]),
        usage: [
          turn('ancient', 1),
          turn('a', 1),
          turn('a', 2),
          turn('b', 1),
          turn('c', 1),
        ],
      }),
    );

    expect(result.versions.map((row) => [row.version, row.ordinal])).toEqual([
      [V2, 2],
      [V1, 1],
    ]);
    const [second, first] = result.versions;
    expect(first!.outcomes.runs).toBe(2);
    expect(first!.outcomes.totals.turns).toBe(3);
    expect(first!.firstRunAt).toBe('2021-01-01T00:00:00.000Z');
    expect(second!.outcomes.totals.costUsd).toBe(2);
    expect(result.totals.runs).toBe(4);
    expect(result.totals.totals.costUsd).toBe(
      first!.outcomes.totals.costUsd! + second!.outcomes.totals.costUsd!,
    );
    expect(result.totals.totals.turns).toBe(5);
    expect(result.totals.statuses).toMatchObject({ completed: 3, failed: 1 });
    expect(second!.runs.map((run) => run.runId)).toEqual(['c', 'b']);
  });

  it('keeps a deleted run’s spend and its stamped status and failed nodes', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('gone', V1, '2026-09-02T00:00:00Z', {
            runStatus: 'failed',
            failedNodes: [{ nodeId: 'dev', name: 'Developer' }],
          }),
        ],
        usage: [turn('gone', 1), turn('gone', 2)],
      }),
    );

    const [row] = result.versions;
    expect(row!.runs[0]).toMatchObject({
      deleted: true,
      status: 'failed',
      title: null,
      costUsd: 2,
    });
    expect(row!.outcomes).toMatchObject({
      failedNodes: [{ nodeId: 'dev', name: 'Developer', count: 1 }],
    });
  });

  it('reads a deleted run that was never stamped as status unknown', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [thread('gone', V1, '2026-09-02T00:00:00Z')],
        usage: [turn('gone', 1)],
      }),
    );
    expect(result.versions[0]!.runs[0]!.status).toBe('unknown');
    expect(result.totals.statuses.unknown).toBe(1);
  });

  it('credits a run’s polled bill once, over its unpriced turns of a polled CLI', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [thread('cursor-run', V2, '2026-10-02T00:00:00Z')],
        live: new Map([live('cursor-run', 'completed')]),
        usage: [
          turn('cursor-run', 1, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', 2, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', POLLED_SPEND_SEQ, {
            agentKind: 'cursor-agent',
            costUsd: 3,
            durationMs: null,
          }),
          turn('cursor-run', POLLED_SPEND_SEQ - 1, {
            agentKind: 'cursor-agent',
            costUsd: 2,
            durationMs: null,
          }),
        ],
      }),
    );

    expect(result.totals.totals).toMatchObject({
      turns: 2,
      costedTurns: 2,
      costUsd: 5,
    });
  });

  it('describes each version against the one before it, and puts copy-less runs in their own row', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('a', V1, '2026-09-02T00:00:00Z', { inferred: true }),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('none', null, '2026-09-01T00:00:00Z', {
            runStatus: 'completed',
          }),
        ],
        live: new Map([live('b', 'running')]),
        liveFailedNodes: new Map([['b', ['qa']]]),
      }),
    );

    const [second, first] = result.versions;
    expect(first).toMatchObject({ ordinal: 1, inferred: true, changes: null });
    expect(second!.inferred).toBe(false);
    expect(second!.changes).toEqual(versionChangesOf(v1, v2));
    expect(second!.outcomes.failedNodes).toEqual([
      { nodeId: 'qa', name: 'QA', count: 1 },
    ]);
    expect(result.unversioned).toMatchObject({
      version: null,
      ordinal: null,
      inferred: false,
      changes: null,
      outcomes: { runs: 1, statuses: { completed: 1 } },
    });
    expect(result.totals.runs).toBe(3);
    expect(result.currentVersion).toBe(V2);
  });
});

describe('an inferred version, which is never registered', () => {
  it('gets no number or change summary and sorts after the numbered versions', () => {
    const result = foldWorkflowVersions(
      input({
        graphs: [graphs[1]!],
        threads: [
          thread('old', V1, '2026-09-11T00:00:00Z', { inferred: true }),
          thread('new', V2, '2026-10-02T00:00:00Z'),
        ],
      }),
    );

    expect(
      result.versions.map((row) => [row.version, row.ordinal, row.inferred]),
    ).toEqual([
      [V2, 1, false],
      [V1, null, true],
    ]);
    expect(result.versions[0]!.changes).toBeNull();
    expect(result.versions[1]!.changes).toBeNull();
  });

  it('names a live run’s failed node from its own stamp', () => {
    const result = foldWorkflowVersions(
      input({
        graphs: [],
        threads: [
          thread('old', V1, '2026-09-11T00:00:00Z', {
            inferred: true,
            failedNodes: [{ nodeId: 'dev', name: 'Developer' }],
          }),
        ],
        live: new Map([live('old', 'failed')]),
        liveFailedNodes: new Map([['old', ['dev']]]),
      }),
    );

    expect(result.totals.failedNodes).toEqual([
      { nodeId: 'dev', name: 'Developer', count: 1 },
    ]);
  });
});

describe('versionChangesOf', () => {
  it('names added, removed and changed nodes, edge changes and the cap', () => {
    expect(versionChangesOf(v1, v2)).toEqual({
      nodesAdded: [{ id: 'qa', name: 'QA' }],
      nodesRemoved: [],
      nodesChanged: [{ id: 'dev', name: 'Developer', fields: ['role'] }],
      edgesAdded: [{ from: 'dev', to: 'qa', kind: 'call' }],
      edgesRemoved: [],
      maxActiveTurns: { from: 2, to: 3 },
    });
    expect(versionChangesOf(v2, v1)).toMatchObject({
      nodesRemoved: [{ id: 'qa', name: 'QA' }],
      edgesRemoved: [{ from: 'dev', to: 'qa', kind: 'call' }],
      maxActiveTurns: { from: 3, to: 2 },
    });
  });

  it('reports no cap change when the cap is the same', () => {
    expect(
      versionChangesOf(v1, { ...v1, name: 'Renamed' }).maxActiveTurns,
    ).toBeNull();
  });
});
