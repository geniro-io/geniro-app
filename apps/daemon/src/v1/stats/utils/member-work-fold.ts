import type { ChatTotalsWire } from '../../agents/chat.types';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import type {
  CallLedgerRow,
  GoalLedgerRow,
  HistoryRecommendationStatus,
  MemberAssessmentEntryWire,
  MemberAssessmentRow,
  MemberWorkWire,
  StageLedgerRow,
  TeamStatsMemberWire,
  ThreadLedgerRow,
  ToolCallLedgerRow,
} from '../stats.types';
import { isPolledSpend } from './polled-spend';
import type { TeamStatsUsageRow } from './team-stats-fold';

export interface MemberRunsInput {
  /** Every thread row of the team, each marked whether the ledgers watched it. */
  threads: readonly Pick<ThreadLedgerRow, 'runId' | 'metrics'>[];
  /** Every usage row of those runs, a turn no CLI timed carrying geniro's clock. */
  usage: readonly TeamStatsUsageRow[];
  toolCalls: readonly ToolCallLedgerRow[];
  calls: readonly CallLedgerRow[];
  stages: readonly StageLedgerRow[];
  goals: readonly GoalLedgerRow[];
  /**
   * The members responsible for a stage in the team version a run ran; empty
   * when that version is not recorded. A stage's rework is theirs, whoever
   * moved it — in `lead` mode the lead moves every stage.
   */
  stageOwners: (runId: string, stageId: string) => readonly string[];
}

/** What one member did in one run. */
export interface MemberRunCell {
  /** The metric ledgers watched the run from its start. */
  measured: boolean;
  spend: ChatTotalsWire;
  callsAnswered: number;
  callsFailed: number;
  timedAnswers: number;
  answerMs: number;
  callsMade: number;
  toolCalls: number;
  toolErrors: number;
  goals: Omit<MemberWorkWire['goals'], 'achievedShare'>;
  stagesCompleted: number;
  completionsReopened: number;
}

/** Member id → run id → what it did there. */
export type MemberRunCells = ReadonlyMap<
  string,
  ReadonlyMap<string, MemberRunCell>
>;

export interface MemberWork {
  /** Every run of the team the member took part in. */
  runs: number;
  perRun: TeamStatsMemberWire['perRun'];
  work: MemberWorkWire | null;
}

/** No call to it failed, no stage it owns was reopened, no goal it recorded ended not achieved. */
export function isCleanRun(cell: MemberRunCell): boolean {
  return (
    cell.callsFailed === 0 &&
    cell.completionsReopened === 0 &&
    cell.goals.notAchieved === 0
  );
}

/**
 * What each member did in each run of the team, from every ledger row of its
 * runs — a deleted run's included.
 */
export function memberRunCells(input: MemberRunsInput): MemberRunCells {
  const runIds = new Set(input.threads.map((thread) => thread.runId));
  const measured = new Set(
    input.threads
      .filter((thread) => thread.metrics === true)
      .map((thread) => thread.runId),
  );
  const cells = new Map<string, Map<string, MemberRunCell>>();
  const cellOf = (memberId: string, runId: string): MemberRunCell => {
    const runs = cells.get(memberId) ?? new Map<string, MemberRunCell>();
    cells.set(memberId, runs);
    const existing = runs.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: MemberRunCell = {
      measured: measured.has(runId),
      spend: emptyTotals(),
      callsAnswered: 0,
      callsFailed: 0,
      timedAnswers: 0,
      answerMs: 0,
      callsMade: 0,
      toolCalls: 0,
      toolErrors: 0,
      goals: { recorded: 0, achieved: 0, notAchieved: 0, open: 0, dropped: 0 },
      stagesCompleted: 0,
      completionsReopened: 0,
    };
    runs.set(runId, fresh);
    return fresh;
  };
  const ours = <T extends { runId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => runIds.has(row.runId));

  for (const row of ours(input.usage)) {
    if (row.memberId === null) {
      continue;
    }
    const cell = cellOf(row.memberId, row.runId);
    if (isPolledSpend(row)) {
      if ((row.costUsd ?? 0) > 0) {
        addPolledSpend(cell.spend, row.costUsd ?? 0, 0);
      }
    } else {
      addUsage(cell.spend, row);
    }
  }
  for (const row of ours(input.toolCalls)) {
    if (row.memberId === null) {
      continue;
    }
    const cell = cellOf(row.memberId, row.runId);
    cell.toolCalls += 1;
    cell.toolErrors += row.ok ? 0 : 1;
  }
  for (const row of ours(input.calls)) {
    if (row.callee !== '') {
      const callee = cellOf(row.callee, row.runId);
      callee.callsAnswered += 1;
      callee.callsFailed += row.ok ? 0 : 1;
      if (row.durationMs !== null) {
        callee.timedAnswers += 1;
        callee.answerMs += row.durationMs;
      }
    }
    if (row.caller !== '') {
      cellOf(row.caller, row.runId).callsMade += 1;
    }
  }
  for (const goal of ours(input.goals)) {
    if (goal.memberId == null) {
      continue;
    }
    const goals = cellOf(goal.memberId, goal.runId).goals;
    goals.recorded += 1;
    if (goal.status === 'achieved') {
      goals.achieved += 1;
    } else if (goal.status === 'not_achieved') {
      goals.notAchieved += 1;
    } else if (goal.status === 'dropped') {
      goals.dropped += 1;
    } else {
      goals.open += 1;
    }
  }

  const stagesByRun = new Map<string, StageLedgerRow[]>();
  for (const row of ours(input.stages)) {
    const list = stagesByRun.get(row.runId) ?? [];
    list.push(row);
    stagesByRun.set(row.runId, list);
  }
  for (const [runId, rows] of stagesByRun) {
    const completedBy = new Map<string, readonly string[]>();
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      if (row.action === 'complete') {
        const owners = input.stageOwners(runId, row.stageId);
        for (const owner of owners) {
          cellOf(owner, runId).stagesCompleted += 1;
        }
        completedBy.set(row.stageId, owners);
      } else if (row.action === 'reopen') {
        for (const owner of completedBy.get(row.stageId) ?? []) {
          cellOf(owner, runId).completionsReopened += 1;
        }
        completedBy.delete(row.stageId);
      }
    }
  }
  return cells;
}

function spreadOf(
  values: readonly number[],
): { min: number; median: number; max: number } | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0]!,
    median:
      sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * What each member did for the team over every run it took part in. A
 * member whose runs the metric ledgers never watched has no work figures
 * (null), never zeros.
 */
export function foldMemberWork(cells: MemberRunCells): Map<string, MemberWork> {
  const folded = new Map<string, MemberWork>();
  for (const [memberId, runs] of cells) {
    const all = [...runs.values()];
    const measured = all.filter((cell) => cell.measured);
    const sum = (pick: (cell: MemberRunCell) => number): number =>
      measured.reduce((total, cell) => total + pick(cell), 0);
    const goals = {
      recorded: sum((cell) => cell.goals.recorded),
      achieved: sum((cell) => cell.goals.achieved),
      notAchieved: sum((cell) => cell.goals.notAchieved),
      open: sum((cell) => cell.goals.open),
      dropped: sum((cell) => cell.goals.dropped),
    };
    const counted = goals.recorded - goals.dropped;
    const timedAnswers = sum((cell) => cell.timedAnswers);
    folded.set(memberId, {
      runs: runs.size,
      perRun: {
        costUsd: spreadOf(
          all.flatMap((cell) =>
            cell.spend.costUsd === null ? [] : [cell.spend.costUsd],
          ),
        ),
        workedMs: spreadOf(
          all.flatMap((cell) =>
            cell.spend.workedMs === null ? [] : [cell.spend.workedMs],
          ),
        ),
      },
      work:
        measured.length === 0
          ? null
          : {
              measuredRuns: measured.length,
              callsAnswered: sum((cell) => cell.callsAnswered),
              callsFailed: sum((cell) => cell.callsFailed),
              avgAnswerMs:
                timedAnswers === 0
                  ? null
                  : Math.round(sum((cell) => cell.answerMs) / timedAnswers),
              callsMade: sum((cell) => cell.callsMade),
              toolCalls: sum((cell) => cell.toolCalls),
              toolErrors: sum((cell) => cell.toolErrors),
              goals: {
                ...goals,
                achievedShare: counted === 0 ? null : goals.achieved / counted,
              },
              cleanRuns: measured.filter(isCleanRun).length,
              stagesCompleted: sum((cell) => cell.stagesCompleted),
              completionsReopened: sum((cell) => cell.completionsReopened),
            },
    });
  }
  return folded;
}

/**
 * Every member's assessments, newest first, each with what became of the
 * items that carry its verdict out — read from the recommendation ledger, so
 * a thread analysis's items, which it never files, have no status.
 */
export function assessmentsByMember(
  rows: readonly MemberAssessmentRow[],
  statusOf: (
    chatRunId: string,
    cardSeq: number,
    itemId: string,
  ) => HistoryRecommendationStatus | null,
  versionsOf: (
    runIds: readonly string[],
  ) => MemberAssessmentEntryWire['versions'],
  sameVendorOf: (row: MemberAssessmentRow) => boolean | null,
): Map<string, MemberAssessmentEntryWire[]> {
  const byMember = new Map<string, MemberAssessmentEntryWire[]>();
  for (const row of [...rows].reverse()) {
    const list = byMember.get(row.memberId) ?? [];
    list.push({
      chatRunId: row.chatRunId,
      chatKind: row.chatKind,
      cardSeq: row.cardSeq,
      filedAt: row.filedAt.toISOString(),
      runs: row.runs,
      versions: versionsOf(row.runIds),
      usefulness: row.usefulness,
      quality: row.quality,
      verdict: row.verdict,
      summary: row.summary,
      evidence: row.evidence.map((evidence) => ({
        runId: evidence.runId ?? null,
        seq: evidence.seq,
        quote: evidence.quote,
      })),
      items: row.items.map((item) => ({
        ...item,
        status:
          row.chatKind === 'thread'
            ? null
            : statusOf(row.chatRunId, row.cardSeq, item.id),
      })),
      judge: { ...row.judge, sameVendor: sameVendorOf(row) },
      userVerdict:
        row.userVerdict === null
          ? null
          : {
              verdict: row.userVerdict.verdict,
              note: row.userVerdict.note,
              at: row.userVerdict.at.toISOString(),
            },
    });
    byMember.set(row.memberId, list);
  }
  return byMember;
}
