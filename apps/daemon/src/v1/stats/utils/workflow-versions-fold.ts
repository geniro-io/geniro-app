import type { ChatTotalsWire, RunFacts } from '../../agents/chat.types';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
  mergeTotals,
  type UsageFigures,
} from '../../agents/utils/usage-figures';
import { servedWorkedMs } from '../../agents/utils/wall-worked';
import type { Workflow } from '../../graphs/graphs.types';
import { diffWorkflows } from '../../graphs/utils/workflow-diff';
import {
  edgeIdentity,
  workflowOfCanonical,
} from '../../graphs/utils/workflow-version';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  FailedNodeStamp,
  LineSnapshotRead,
  ThreadLedgerRow,
  VersionChangesWire,
  VersionEdgeRefWire,
  VersionOutcomesWire,
  VersionRunStatus,
  VersionRunWire,
  WorkflowVersionGraph,
  WorkflowVersionRowWire,
  WorkflowVersionsWire,
} from '../stats.types';
import { linesIncrements } from './activity-fold';
import {
  isPolledSpend,
  PolledTurnCredit,
  tallyUnpricedTurn,
} from './polled-spend';

/** One `usage_events` row as the fold reads it. */
export type UsageLedgerRow = Pick<UsageEvent, 'runId' | 'seq' | 'agentKind'> &
  UsageFigures;

/** Everything one workflow's versions table is folded from — every row of its runs. */
export interface WorkflowVersionsInput {
  slug: string;
  currentVersion: string | null;
  /** Every thread row stamped with the workflow, a deleted run's included. */
  threads: readonly ThreadLedgerRow[];
  /** The runs that still exist, by id. */
  live: ReadonlyMap<string, RunFacts>;
  usage: readonly UsageLedgerRow[];
  /** The CLIs whose money is polled from the account (`pollsSpendFor`). */
  polledKinds: readonly string[];
  /** A live run's nodes whose last pass failed, the boot reconcile's excluded. */
  liveFailedNodes: ReadonlyMap<string, readonly string[]>;
  /** A live run's whole `wall_turns` sum; absent means none recorded. */
  liveWallMs: ReadonlyMap<string, number>;
  pullRequests: ReadonlyMap<string, number>;
  /** Every lines snapshot of every series the runs measured. */
  lines: readonly LineSnapshotRead[];
  /** The workflow's recorded versions, oldest first. */
  graphs: readonly WorkflowVersionGraph[];
}

interface RunFold {
  thread: ThreadLedgerRow;
  live: RunFacts | undefined;
  totals: ChatTotalsWire;
  workedMs: number | null;
  wallKnown: boolean;
  status: VersionRunStatus;
  failedNodes: FailedNodeStamp[];
  pullRequests: number;
  lines: { added: number; removed: number } | null;
}

function addNullable(a: number | null, b: number | null): number | null {
  return b === null ? a : (a ?? 0) + b;
}

/** Each run's spend: its turns, then its polled bill spread over its unpriced turns. */
function totalsByRun(
  usage: readonly UsageLedgerRow[],
  polledKinds: readonly string[],
): Map<string, ChatTotalsWire> {
  const totals = new Map<string, ChatTotalsWire>();
  const of = (runId: string): ChatTotalsWire => {
    const existing = totals.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = emptyTotals();
    totals.set(runId, fresh);
    return fresh;
  };
  const unpriced = new Map<string, number>();
  const polled: UsageLedgerRow[] = [];
  for (const row of usage) {
    if (isPolledSpend(row)) {
      polled.push(row);
      continue;
    }
    addUsage(of(row.runId), row);
    tallyUnpricedTurn(unpriced, row);
  }
  const credit = new PolledTurnCredit(unpriced, polledKinds);
  for (const row of [...polled].sort((a, b) => b.seq - a.seq)) {
    const costUsd = row.costUsd ?? 0;
    if (costUsd > 0) {
      addPolledSpend(of(row.runId), costUsd, credit.next(row).turns);
    }
  }
  return totals;
}

/** Each run's line growth: what its own snapshots added past its series' peak. */
function linesByRun(
  snapshots: readonly LineSnapshotRead[],
): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const increment of linesIncrements(snapshots, new Map())) {
    const lines = out.get(increment.runId) ?? { added: 0, removed: 0 };
    lines.added += increment.addedDelta;
    lines.removed += increment.removedDelta;
    out.set(increment.runId, lines);
  }
  return out;
}

function nodeNamesOf(workflow: Workflow | null): Map<string, string | null> {
  return new Map(
    (workflow?.nodes ?? []).map((node) => [node.id, node.name ?? null]),
  );
}

function outcomesOf(runs: readonly RunFold[]): VersionOutcomesWire {
  const statuses = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    pending: 0,
    unknown: 0,
  };
  const failed = new Map<string, { name: string | null; count: number }>();
  const totals = emptyTotals();
  let pullRequests = 0;
  const lines = { added: 0, removed: 0, measured: false };
  let workedMs: number | null = null;
  let workedPartial = false;
  for (const run of runs) {
    statuses[run.status] += 1;
    for (const node of run.failedNodes) {
      const entry = failed.get(node.nodeId) ?? { name: null, count: 0 };
      entry.name ??= node.name;
      entry.count += 1;
      failed.set(node.nodeId, entry);
    }
    mergeTotals(totals, run.totals);
    pullRequests += run.pullRequests;
    if (run.lines !== null) {
      lines.added += run.lines.added;
      lines.removed += run.lines.removed;
      lines.measured = true;
    }
    workedMs = addNullable(workedMs, run.workedMs);
    if (!run.wallKnown) {
      workedPartial = true;
    }
  }
  return {
    runs: runs.length,
    statuses,
    failedNodes: [...failed]
      .map(([nodeId, entry]) => ({ nodeId, ...entry }))
      .sort((a, b) => b.count - a.count || (a.nodeId < b.nodeId ? -1 : 1)),
    totals,
    pullRequests,
    lines: lines.measured
      ? { added: lines.added, removed: lines.removed }
      : null,
    workedMs,
    workedPartial,
  };
}

function edgesOf(workflow: Workflow): Map<string, VersionEdgeRefWire> {
  return new Map(
    workflow.edges.map((edge) => [
      edgeIdentity(edge),
      { from: edge.from, to: edge.to, kind: edge.kind },
    ]),
  );
}

/** What `next` changed against `prev`, by node and edge. */
export function versionChangesOf(
  prev: Workflow,
  next: Workflow,
): VersionChangesWire {
  const diff = diffWorkflows(prev, next);
  const prevNames = nodeNamesOf(prev);
  const nextNames = nodeNamesOf(next);
  const prevEdges = edgesOf(prev);
  const nextEdges = edgesOf(next);
  const prevCap = prev.maxActiveTurns ?? null;
  const nextCap = next.maxActiveTurns ?? null;
  return {
    nodesAdded: diff.addedNodes.map((id) => ({
      id,
      name: nextNames.get(id) ?? null,
    })),
    nodesRemoved: diff.removedNodes.map((id) => ({
      id,
      name: prevNames.get(id) ?? null,
    })),
    nodesChanged: diff.changedNodes.map((node) => ({
      id: node.id,
      name: nextNames.get(node.id) ?? null,
      fields: node.fields.map((field) => field.field),
    })),
    edgesAdded: [...nextEdges]
      .filter(([key]) => !prevEdges.has(key))
      .map(([, edge]) => edge),
    edgesRemoved: [...prevEdges]
      .filter(([key]) => !nextEdges.has(key))
      .map(([, edge]) => edge),
    maxActiveTurns: prevCap === nextCap ? null : { from: prevCap, to: nextCap },
  };
}

function rowOf(
  version: string | null,
  runs: readonly RunFold[],
  ordinal: number | null,
  changes: VersionChangesWire | null,
): WorkflowVersionRowWire {
  const byNewest = [...runs].sort(
    (a, b) => b.thread.occurredAt.getTime() - a.thread.occurredAt.getTime(),
  );
  return {
    version,
    ordinal,
    inferred:
      version !== null && runs.every((run) => run.thread.inferred === true),
    firstRunAt: byNewest[byNewest.length - 1]!.thread.occurredAt.toISOString(),
    lastRunAt: byNewest[0]!.thread.occurredAt.toISOString(),
    changes,
    outcomes: outcomesOf(runs),
    runs: byNewest.map((run): VersionRunWire => ({
      runId: run.thread.runId,
      title: run.live?.title ?? null,
      createdAt: run.thread.occurredAt.toISOString(),
      status: run.status,
      deleted: run.live === undefined,
      costUsd: run.totals.costUsd,
      estimated: (run.totals.estimatedCostUsd ?? 0) > 0,
    })),
  };
}

/**
 * One workflow's runs grouped by the graph version they ran, each group's outcomes folded
 * over its runs' own rows, and the workflow's total folded over every run directly.
 *
 * A live run is read as it stands; a deleted one from what the ledger kept: its spend, its
 * pull requests and lines, and the status, failed nodes and wall time stamped when it last
 * settled. What neither kept is not measured, never zero.
 */
export function foldWorkflowVersions(
  input: WorkflowVersionsInput,
): WorkflowVersionsWire {
  const totals = totalsByRun(input.usage, input.polledKinds);
  const lines = linesByRun(input.lines);
  const versions = new Map(
    input.graphs.map((graph, index) => [
      graph.version,
      { ordinal: index + 1, workflow: workflowOfCanonical(graph.graph) },
    ]),
  );
  const workflowOrdinal = new Map(
    [...versions.values()].map((entry) => [entry.ordinal, entry.workflow]),
  );

  const runs: RunFold[] = input.threads.map((thread) => {
    const live = input.live.get(thread.runId);
    const runTotals = totals.get(thread.runId) ?? emptyTotals();
    const wallMs =
      live !== undefined
        ? (input.liveWallMs.get(thread.runId) ?? 0)
        : thread.wallMs;
    // The version's recorded graph names the nodes; an unregistered (inferred) version
    // has none, so the names the run's own last stamp kept stand in.
    const names = nodeNamesOf(
      thread.version === null
        ? null
        : (versions.get(thread.version)?.workflow ?? null),
    );
    for (const node of thread.failedNodes ?? []) {
      if (!names.has(node.nodeId)) {
        names.set(node.nodeId, node.name);
      }
    }
    return {
      thread,
      live,
      totals: runTotals,
      workedMs: servedWorkedMs(runTotals.workedMs, wallMs),
      wallKnown: wallMs !== null,
      status: live?.status ?? thread.runStatus ?? 'unknown',
      failedNodes:
        live !== undefined
          ? [...(input.liveFailedNodes.get(thread.runId) ?? [])]
              .sort()
              .map((nodeId) => ({ nodeId, name: names.get(nodeId) ?? null }))
          : (thread.failedNodes ?? []),
      pullRequests: input.pullRequests.get(thread.runId) ?? 0,
      lines: lines.get(thread.runId) ?? null,
    };
  });

  const byVersion = new Map<string, RunFold[]>();
  const unversioned: RunFold[] = [];
  for (const run of runs) {
    if (run.thread.version === null) {
      unversioned.push(run);
      continue;
    }
    const list = byVersion.get(run.thread.version) ?? [];
    list.push(run);
    byVersion.set(run.thread.version, list);
  }

  const rows = [...byVersion].map(([version, versionRuns]) => {
    const recorded = versions.get(version);
    const prev =
      recorded === undefined || recorded.ordinal === 1
        ? null
        : (workflowOrdinal.get(recorded.ordinal - 1) ?? null);
    return rowOf(
      version,
      versionRuns,
      recorded?.ordinal ?? null,
      prev !== null && recorded?.workflow
        ? versionChangesOf(prev, recorded.workflow)
        : null,
    );
  });
  // Numbered versions newest first, then the unnumbered (inferred) ones by their runs.
  rows.sort(
    (a, b) =>
      (b.ordinal ?? 0) - (a.ordinal ?? 0) ||
      b.lastRunAt.localeCompare(a.lastRunAt),
  );

  return {
    slug: input.slug,
    currentVersion: input.currentVersion,
    versions: rows,
    unversioned:
      unversioned.length === 0 ? null : rowOf(null, unversioned, null, null),
    totals: outcomesOf(runs),
  };
}
