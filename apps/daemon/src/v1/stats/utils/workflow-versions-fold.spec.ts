import { describe, expect, it, vi } from 'vitest';

import type { Workflow } from '../../graphs/graphs.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
import {
  POLLED_SPEND_SEQ,
  type ThreadLedgerRow,
  type VersionChangesWire,
} from '../stats.types';
import {
  foldWorkflowVersions,
  type UsageLedgerRow,
  type WorkflowVersionsInput,
} from './workflow-versions-fold';

const v1: Workflow = {
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'start', to: 'dev', kind: 'data' }],
};
const v2: Workflow = {
  ...v1,
  nodes: [
    ...v1.nodes,
    { id: 'qa', kind: 'agent', agent: 'cursor-agent', approval: 'auto' },
  ],
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

const CHANGES: VersionChangesWire = { added: 3, removed: 0, diff: '+qa' };

function thread(
  runId: string,
  version: string | null,
  occurredAt: string,
  inferred = false,
): ThreadLedgerRow {
  return {
    runId,
    occurredAt: new Date(occurredAt),
    slug: 'dev-team',
    version,
    inferred: version === null ? null : inferred,
  };
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
    usage: [],
    polledKinds: ['cursor-agent'],
    graphs,
    unrecorded: null,
    changesOf: () => CHANGES,
    ...overrides,
  };
}

describe('foldWorkflowVersions', () => {
  it('counts each version’s runs and cost, a run years old included, and folds the total over every run', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('ancient', V1, '2021-01-01T00:00:00Z'),
          thread('a', V1, '2026-09-02T00:00:00Z'),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('c', V2, '2026-10-03T00:00:00Z'),
        ],
        usage: [
          turn('ancient', 1),
          turn('a', 1),
          turn('a', 2),
          turn('b', 1, { costUsd: 4 }),
          turn('c', 1),
        ],
      }),
    );

    expect(result.versions.map((row) => [row.version, row.ordinal])).toEqual([
      [V2, 2],
      [V1, 1],
    ]);
    const [second, first] = result.versions;
    expect(first).toMatchObject({
      firstRunAt: '2021-01-01T00:00:00.000Z',
      lastRunAt: '2026-09-02T00:00:00.000Z',
      figures: { runs: 2, costUsd: 3, avgCostUsd: 1.5 },
    });
    expect(second!.figures).toMatchObject({
      runs: 2,
      costUsd: 5,
      avgCostUsd: 2.5,
    });
    expect(result.totals).toMatchObject({
      runs: 4,
      costUsd: 8,
      avgCostUsd: 2,
    });
  });

  it('averages over the runs that reported a cost, and reads none as not measured', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('priced', V2, '2026-10-02T00:00:00Z'),
          thread('silent', V2, '2026-10-03T00:00:00Z'),
          thread('old', V1, '2026-09-02T00:00:00Z'),
        ],
        usage: [
          turn('priced', 1, { costUsd: 6, estimatedCostUsd: 2 }),
          turn('silent', 1, { costUsd: null }),
          turn('old', 1, { costUsd: null }),
        ],
      }),
    );

    expect(result.versions[0]!.figures).toEqual({
      runs: 2,
      costUsd: 6,
      avgCostUsd: 6,
      estimatedCostUsd: 2,
    });
    expect(result.versions[1]!.figures).toEqual({
      runs: 1,
      costUsd: null,
      avgCostUsd: null,
      estimatedCostUsd: null,
    });
  });

  it('credits a run’s polled bill once, over its unpriced turns of a polled CLI', () => {
    const result = foldWorkflowVersions(
      input({
        threads: [thread('cursor-run', V2, '2026-10-02T00:00:00Z')],
        usage: [
          turn('cursor-run', 1, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', 2, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', POLLED_SPEND_SEQ, {
            agentKind: 'cursor-agent',
            costUsd: 3,
          }),
          turn('cursor-run', POLLED_SPEND_SEQ - 1, {
            agentKind: 'cursor-agent',
            costUsd: 2,
          }),
        ],
      }),
    );

    expect(result.totals).toMatchObject({ runs: 1, costUsd: 5, avgCostUsd: 5 });
  });

  it('diffs each version against the one numbered before it, and puts copy-less runs in their own row', () => {
    const changesOf = vi.fn(() => CHANGES);
    const result = foldWorkflowVersions(
      input({
        threads: [
          thread('a', V1, '2026-09-02T00:00:00Z'),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('none', null, '2026-09-01T00:00:00Z'),
        ],
        changesOf,
      }),
    );

    const [second, first] = result.versions;
    expect(second!.changes).toBe(CHANGES);
    expect(first!.changes).toBeNull();
    expect(changesOf).toHaveBeenCalledTimes(1);
    expect(changesOf).toHaveBeenCalledWith(graphs[0], graphs[1]);
    expect(result.unversioned).toMatchObject({
      version: null,
      ordinal: null,
      inferred: false,
      changes: null,
      figures: { runs: 1 },
    });
    expect(result.totals.runs).toBe(3);
    expect(result.currentVersion).toBe(V2);
  });
});

describe('an inferred version, which is never registered', () => {
  it('gets no number or diff and sorts after the numbered versions', () => {
    const result = foldWorkflowVersions(
      input({
        graphs: [graphs[1]!],
        threads: [
          thread('old', V1, '2026-09-11T00:00:00Z', true),
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
});

describe('versions no run has stamped', () => {
  it('keeps a recorded version with no runs as a row, numbered, with no dates', () => {
    const result = foldWorkflowVersions(
      input({ threads: [thread('a', V1, '2026-09-02T00:00:00Z')] }),
    );

    expect(result.versions[0]).toMatchObject({
      version: V2,
      ordinal: 2,
      inferred: false,
      recorded: true,
      firstRunAt: null,
      lastRunAt: null,
      changes: CHANGES,
      figures: { runs: 0, costUsd: null, avgCostUsd: null },
    });
    expect(result.totals.runs).toBe(1);
  });

  it('shows the library graph before its first run, first, diffed against the newest recorded version', () => {
    const v3: Workflow = { ...v2, maxActiveTurns: 4 };
    const edited = {
      version: workflowVersionOf(v3),
      graph: canonicalGraphJson(canonicalGraphOf(v3)),
      firstSeenAt: new Date('2026-10-27T00:00:00Z'),
    };
    const changesOf = vi.fn(() => CHANGES);

    const result = foldWorkflowVersions(
      input({
        currentVersion: edited.version,
        unrecorded: edited,
        threads: [thread('b', V2, '2026-10-02T00:00:00Z')],
        changesOf,
      }),
    );

    expect(result.versions[0]).toMatchObject({
      version: edited.version,
      ordinal: null,
      recorded: false,
      firstRunAt: null,
      changes: CHANGES,
      figures: { runs: 0 },
    });
    expect(changesOf).toHaveBeenCalledWith(graphs[1], edited);
  });

  it('gives no second row to a library graph an inferred version already shows', () => {
    const result = foldWorkflowVersions(
      input({
        graphs: [],
        currentVersion: V1,
        unrecorded: { ...graphs[0]!, firstSeenAt: new Date() },
        threads: [thread('old', V1, '2026-09-11T00:00:00Z', true)],
      }),
    );

    expect(result.versions.map((row) => row.version)).toEqual([V1]);
    expect(result.versions[0]!.recorded).toBe(true);
  });
});
