import type { ChatTotalsWire } from '../../agents/chat.types';
import { wallTurnKey } from '../../agents/dao/wall-turn.dao';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  MemberAssessmentEntryWire,
  MemberChangeWire,
  RunOutcomeLedgerRow,
  TeamStatsDayWire,
  TeamStatsMemberWire,
  TeamStatsWire,
  ThreadLedgerRow,
} from '../stats.types';
import type { MemberWork } from './member-work-fold';
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
  /**
   * geniro's clock for turns no CLI timed, keyed by `wallTurnKey(runId, seq)` —
   * the seq of the turn's own ledger row.
   */
  wallTurns?: ReadonlyMap<string, number>;
  /** Each member's work from the metric ledgers (`foldMemberWork`). */
  memberWork?: ReadonlyMap<string, MemberWork>;
  /** Each member's assessments, newest first (`assessmentsByMember`). */
  assessments?: ReadonlyMap<string, readonly MemberAssessmentEntryWire[]>;
  /** Each member's changes between versions, newest first (`foldMemberChanges`). */
  changes?: ReadonlyMap<string, readonly MemberChangeWire[]>;
}

/** Usage rows with geniro's clock in place of a missing CLI time, keyed by `wallTurnKey(runId, seq)`. */
export function withWallTimes<Row extends TeamStatsUsageRow>(
  usage: readonly Row[],
  wallTurns: ReadonlyMap<string, number> | undefined,
): Row[] {
  return usage.map((row) => {
    const wall = wallTurns?.get(wallTurnKey(row.runId, row.seq));
    return wall === undefined || row.durationMs !== null || isPolledSpend(row)
      ? row
      : { ...row, durationMs: wall };
  });
}

interface DayCell {
  runs: number;
  spend: ChatTotalsWire;
  outcomes: number;
}

interface MemberCell {
  spend: ChatTotalsWire;
  measuredMs: number;
  agentKind: string | null;
  agentKindAt: number;
}

/** One team's statistics, folded over every row its runs left in the ledgers. */
export function foldTeamStats(
  input: TeamStatsInput,
): Omit<TeamStatsWire, 'metrics' | 'assessmentVerdicts'> {
  let measuredWorkedMs = 0;
  const measuredOf = new Map<TeamStatsUsageRow, number>();
  const usage = input.usage.map((row) => {
    const wall = input.wallTurns?.get(wallTurnKey(row.runId, row.seq));
    if (wall === undefined || row.durationMs !== null || isPolledSpend(row)) {
      return row;
    }
    const timed = { ...row, durationMs: wall };
    measuredWorkedMs += wall;
    measuredOf.set(timed, wall);
    return timed;
  });
  const totals = emptyTotals();
  for (const run of totalsByRun(usage, input.polledKinds).values()) {
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
      measuredMs: 0,
      agentKind: null,
      agentKindAt: Number.NEGATIVE_INFINITY,
    };
    members.set(memberId, fresh);
    return fresh;
  };

  for (const row of usage) {
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
    member.measuredMs += measuredOf.get(row) ?? 0;
    if (polled) {
      if (costUsd > 0) {
        addPolledSpend(member.spend, costUsd, 0);
      }
    } else {
      addUsage(member.spend, row);
    }
    const at = polled ? Number.NEGATIVE_INFINITY : row.occurredAt.getTime();
    if (row.agentKind !== null && at >= member.agentKindAt) {
      member.agentKind = row.agentKind;
      member.agentKindAt = at;
    }
  }

  for (const memberId of [
    ...(input.memberWork?.keys() ?? []),
    ...(input.assessments?.keys() ?? []),
    ...(input.changes?.keys() ?? []),
  ]) {
    memberOf(memberId);
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
    measuredWorkedMs,
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
        measuredWorkedMs: cell.measuredMs,
        runs: input.memberWork?.get(memberId)?.runs ?? 0,
        perRun: input.memberWork?.get(memberId)?.perRun ?? {
          costUsd: null,
          workedMs: null,
        },
        work: input.memberWork?.get(memberId)?.work ?? null,
        changes: [...(input.changes?.get(memberId) ?? [])],
        assessments: [...(input.assessments?.get(memberId) ?? [])],
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
