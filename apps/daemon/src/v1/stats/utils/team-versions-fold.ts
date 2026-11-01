import type { ChatTotalsWire } from '../../agents/chat.types';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
  type UsageFigures,
} from '../../agents/utils/usage-figures';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  TeamVersionGraph,
  TeamVersionRowWire,
  TeamVersionsWire,
  ThreadLedgerRow,
  VersionChangesWire,
  VersionFiguresWire,
} from '../stats.types';
import {
  isPolledSpend,
  PolledTurnCredit,
  tallyUnpricedTurn,
} from './polled-spend';

/** One `usage_events` row as the fold reads it. */
export type UsageLedgerRow = Pick<UsageEvent, 'runId' | 'seq' | 'agentKind'> &
  UsageFigures;

/** Everything one team's versions table is folded from — every row of its runs. */
export interface TeamVersionsInput {
  slug: string;
  currentVersion: string | null;
  /** Every thread row stamped with the team, a deleted run's included. */
  threads: readonly ThreadLedgerRow[];
  usage: readonly UsageLedgerRow[];
  /** The CLIs whose money is polled from the account (`pollsSpendFor`). */
  polledKinds: readonly string[];
  /** The team's recorded versions, oldest first. */
  graphs: readonly TeamVersionGraph[];
  /**
   * The library's graph when no version records it yet: edited since its last run, or
   * never run. It is the current version all the same, so it gets a row.
   */
  unrecorded: TeamVersionGraph | null;
  /** What `next` changed against `previous`, or null when either graph no longer reads. */
  changesOf: (
    previous: TeamVersionGraph,
    next: TeamVersionGraph,
  ) => VersionChangesWire | null;
}

/** Each run's spend: its turns, then its polled bill spread over its unpriced turns. */
export function totalsByRun(
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
  recorded = true,
): TeamVersionRowWire {
  const times = threads.map((thread) => thread.occurredAt.getTime());
  return {
    version,
    ordinal,
    inferred:
      threads.length > 0 &&
      version !== null &&
      threads.every((thread) => thread.inferred === true),
    recorded,
    firstRunAt:
      times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
    lastRunAt:
      times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    changes,
    figures: figuresOf(threads, totals),
  };
}

/**
 * One team's runs grouped by the graph version they ran: each version's runs and
 * cost, and its graph's diff against the version recorded before it. The team's
 * total is folded over every run directly. A deleted run counts through what the ledger
 * kept of it.
 */
export function foldTeamVersions(input: TeamVersionsInput): TeamVersionsWire {
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

  // A recorded version no run has stamped yet (the graph a restore replaced) is a row of
  // its own, so it can be restored back.
  for (const graph of input.graphs) {
    if (!byVersion.has(graph.version)) {
      byVersion.set(graph.version, []);
    }
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
      (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''),
  );
  const unrecorded =
    input.unrecorded !== null && !byVersion.has(input.unrecorded.version)
      ? input.unrecorded
      : null;
  if (unrecorded !== null) {
    // The library's graph ahead of every recorded one, against the newest of them.
    const newest = input.graphs[input.graphs.length - 1];
    rows.unshift(
      rowOf(
        unrecorded.version,
        [],
        totals,
        null,
        newest === undefined ? null : input.changesOf(newest, unrecorded),
        false,
      ),
    );
  }

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
