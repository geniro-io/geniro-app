import type { ChatTotalsWire } from '../../agents/chat.types';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  RunOutcomeLedgerRow,
  TeamStatsDayWire,
  TeamStatsMemberWire,
  TeamStatsWire,
  ThreadLedgerRow,
} from '../stats.types';
import { isPolledSpend } from './polled-spend';
import { totalsByRun, type UsageLedgerRow } from './team-versions-fold';
import { localDateKey } from './usage-fold';

/** One `usage_events` row as this fold reads it. */
export type TeamStatsUsageRow = UsageLedgerRow &
  Pick<UsageEvent, 'memberId' | 'occurredAt'>;

export interface TeamStatsInput {
  slug: string;
  /** Every thread row stamped with the team, a deleted run's included. */
  threads: readonly ThreadLedgerRow[];
  /** Every ledger row of those runs. */
  usage: readonly TeamStatsUsageRow[];
  /** The CLIs whose money is polled from the account (`pollsSpendFor`). */
  polledKinds: readonly string[];
  /** The team's pull request outcomes, one per run and pull request. */
  outcomes: readonly RunOutcomeLedgerRow[];
}

interface DayCell {
  runs: number;
  spend: ChatTotalsWire;
  outcomes: number;
}

interface MemberCell {
  spend: ChatTotalsWire;
  agentKind: string | null;
  agentKindAt: number;
}

/** One team's statistics, folded over every row its runs left in the ledgers. */
export function foldTeamStats(
  input: TeamStatsInput,
): Omit<TeamStatsWire, 'metrics'> {
  const totals = emptyTotals();
  for (const run of totalsByRun(input.usage, input.polledKinds).values()) {
    totals.turns += run.turns;
    totals.costUsd = sum(totals.costUsd, run.costUsd);
    totals.estimatedCostUsd = sum(
      totals.estimatedCostUsd,
      run.estimatedCostUsd,
    );
    totals.workedMs = sum(totals.workedMs, run.workedMs);
  }

  const days = new Map<string, DayCell>();
  const dayOf = (at: Date): DayCell => {
    const key = localDateKey(at);
    const existing = days.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: DayCell = { runs: 0, spend: emptyTotals(), outcomes: 0 };
    days.set(key, fresh);
    return fresh;
  };
  for (const thread of input.threads) {
    dayOf(thread.occurredAt).runs += 1;
  }

  const members = new Map<string, MemberCell>();
  const memberOf = (memberId: string): MemberCell => {
    const existing = members.get(memberId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: MemberCell = {
      spend: emptyTotals(),
      agentKind: null,
      agentKindAt: Number.NEGATIVE_INFINITY,
    };
    members.set(memberId, fresh);
    return fresh;
  };

  for (const row of input.usage) {
    const polled = isPolledSpend(row);
    const costUsd = row.costUsd ?? 0;
    const day = dayOf(row.occurredAt);
    if (polled) {
      if (costUsd > 0) {
        addPolledSpend(day.spend, costUsd, 0);
      }
    } else {
      addUsage(day.spend, row);
    }
    if (row.memberId === null) {
      continue;
    }
    const member = memberOf(row.memberId);
    if (polled) {
      if (costUsd > 0) {
        addPolledSpend(member.spend, costUsd, 0);
      }
    } else {
      addUsage(member.spend, row);
    }
    const at = row.occurredAt.getTime();
    if (row.agentKind !== null && at >= member.agentKindAt) {
      member.agentKind = row.agentKind;
      member.agentKindAt = at;
    }
  }

  const runIds = new Set(input.threads.map((thread) => thread.runId));
  const outcomes = input.outcomes.filter((outcome) =>
    runIds.has(outcome.runId),
  );
  for (const outcome of outcomes) {
    dayOf(outcome.occurredAt).outcomes += 1;
  }

  return {
    slug: input.slug,
    runs: input.threads.length,
    costUsd: totals.costUsd,
    estimatedCostUsd: totals.estimatedCostUsd,
    turns: totals.turns,
    workedMs: totals.workedMs,
    outcomes: {
      total: outcomes.length,
      accepted: countOf(outcomes, 'accepted'),
      changesRequested: countOf(outcomes, 'changes_requested'),
      notYet: countOf(outcomes, 'not_yet'),
      notNeeded: countOf(outcomes, 'not_needed'),
    },
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, cell]): TeamStatsDayWire => ({
        day,
        runs: cell.runs,
        costUsd: cell.spend.costUsd,
        turns: cell.spend.turns,
        workedMs: cell.spend.workedMs,
        outcomes: cell.outcomes,
      })),
    byMember: [...members]
      .map(([memberId, cell]): TeamStatsMemberWire => ({
        memberId,
        agentKind: cell.agentKind,
        costUsd: cell.spend.costUsd,
        turns: cell.spend.turns,
        workedMs: cell.spend.workedMs,
      }))
      .sort(
        (a, b) =>
          (b.costUsd ?? 0) - (a.costUsd ?? 0) ||
          b.turns - a.turns ||
          a.memberId.localeCompare(b.memberId),
      ),
  };
}

function sum(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

function countOf(
  outcomes: readonly RunOutcomeLedgerRow[],
  acceptance: RunOutcomeLedgerRow['acceptance'],
): number {
  return outcomes.filter((outcome) => outcome.acceptance === acceptance).length;
}
