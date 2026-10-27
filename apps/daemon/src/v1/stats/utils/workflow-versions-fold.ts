import type { ChatTotalsWire } from '../../agents/chat.types';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
  type UsageFigures,
} from '../../agents/utils/usage-figures';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  ThreadLedgerRow,
  VersionChangesWire,
  VersionFiguresWire,
  WorkflowVersionGraph,
  WorkflowVersionRowWire,
  WorkflowVersionsWire,
} from '../stats.types';
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
  usage: readonly UsageLedgerRow[];
  /** The CLIs whose money is polled from the account (`pollsSpendFor`). */
  polledKinds: readonly string[];
  /** The workflow's recorded versions, oldest first. */
  graphs: readonly WorkflowVersionGraph[];
  /** What `next` changed against `previous`, or null when either graph no longer reads. */
  changesOf: (
    previous: WorkflowVersionGraph,
    next: WorkflowVersionGraph,
  ) => VersionChangesWire | null;
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

/** What a set of runs cost, and what each of those that reported a cost cost on average. */
function figuresOf(
  threads: readonly ThreadLedgerRow[],
  totals: ReadonlyMap<string, ChatTotalsWire>,
): VersionFiguresWire {
  let costUsd: number | null = null;
  let estimatedCostUsd: number | null = null;
  let priced = 0;
  for (const thread of threads) {
    const run = totals.get(thread.runId);
    if (run === undefined || run.costUsd === null) {
      continue;
    }
    costUsd = (costUsd ?? 0) + run.costUsd;
    priced += 1;
    if (run.estimatedCostUsd !== null) {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + run.estimatedCostUsd;
    }
  }
  return {
    runs: threads.length,
    costUsd,
    avgCostUsd: costUsd === null ? null : costUsd / priced,
    estimatedCostUsd,
  };
}

function rowOf(
  version: string | null,
  threads: readonly ThreadLedgerRow[],
  totals: ReadonlyMap<string, ChatTotalsWire>,
  ordinal: number | null,
  changes: VersionChangesWire | null,
): WorkflowVersionRowWire {
  const times = threads.map((thread) => thread.occurredAt.getTime());
  return {
    version,
    ordinal,
    inferred:
      version !== null && threads.every((thread) => thread.inferred === true),
    firstRunAt: new Date(Math.min(...times)).toISOString(),
    lastRunAt: new Date(Math.max(...times)).toISOString(),
    changes,
    figures: figuresOf(threads, totals),
  };
}

/**
 * One workflow's runs grouped by the graph version they ran: each version's runs and
 * cost, and its graph's diff against the version recorded before it. The workflow's
 * total is folded over every run directly. A deleted run counts through what the ledger
 * kept of it.
 */
export function foldWorkflowVersions(
  input: WorkflowVersionsInput,
): WorkflowVersionsWire {
  const totals = totalsByRun(input.usage, input.polledKinds);
  const ordinals = new Map(
    input.graphs.map((graph, index) => [graph.version, index + 1]),
  );

  const byVersion = new Map<string, ThreadLedgerRow[]>();
  const unversioned: ThreadLedgerRow[] = [];
  for (const thread of input.threads) {
    if (thread.version === null) {
      unversioned.push(thread);
      continue;
    }
    const list = byVersion.get(thread.version) ?? [];
    list.push(thread);
    byVersion.set(thread.version, list);
  }

  const rows = [...byVersion].map(([version, threads]) => {
    const ordinal = ordinals.get(version) ?? null;
    const previous =
      ordinal === null || ordinal === 1 ? null : input.graphs[ordinal - 2]!;
    return rowOf(
      version,
      threads,
      totals,
      ordinal,
      previous === null
        ? null
        : input.changesOf(previous, input.graphs[ordinal! - 1]!),
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
      unversioned.length === 0
        ? null
        : rowOf(null, unversioned, totals, null, null),
    totals: figuresOf(input.threads, totals),
  };
}
