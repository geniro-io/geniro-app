import type {
  CallLedgerRow,
  GoalLedgerRow,
  HistoryRecommendationStatus,
  MemberAssessmentEntryWire,
  MemberAssessmentRow,
  MemberWorkWire,
  StageLedgerRow,
  ThreadLedgerRow,
  ToolCallLedgerRow,
} from '../stats.types';

export interface MemberWorkInput {
  /** Every thread row of the team, each marked whether the ledgers watched it. */
  threads: readonly Pick<ThreadLedgerRow, 'runId' | 'metrics'>[];
  /** Which members took a turn in which run, from the usage ledger. */
  turns: readonly { runId: string; memberId: string | null }[];
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

export interface MemberWork {
  /** Every run of the team the member took part in. */
  runs: number;
  work: MemberWorkWire | null;
}

interface Cell {
  runs: Set<string>;
  measured: Set<string>;
  callsAnswered: number;
  callsFailed: number;
  timedAnswers: number;
  answerMs: number;
  callsMade: number;
  toolCalls: number;
  toolErrors: number;
  goals: MemberWorkWire['goals'];
  stagesCompleted: number;
  completionsReopened: number;
}

/**
 * What each member did for the team, folded over every ledger row of its runs —
 * a deleted run's included. A member whose runs the metric ledgers never
 * watched has no work figures (null), never zeros.
 */
export function foldMemberWork(
  input: MemberWorkInput,
): Map<string, MemberWork> {
  const runIds = new Set(input.threads.map((thread) => thread.runId));
  const measured = new Set(
    input.threads
      .filter((thread) => thread.metrics === true)
      .map((thread) => thread.runId),
  );
  const cells = new Map<string, Cell>();
  const cellOf = (memberId: string, runId: string): Cell => {
    const cell = cells.get(memberId) ?? {
      runs: new Set<string>(),
      measured: new Set<string>(),
      callsAnswered: 0,
      callsFailed: 0,
      timedAnswers: 0,
      answerMs: 0,
      callsMade: 0,
      toolCalls: 0,
      toolErrors: 0,
      goals: {
        recorded: 0,
        achieved: 0,
        notAchieved: 0,
        open: 0,
        dropped: 0,
        achievedShare: null,
      },
      stagesCompleted: 0,
      completionsReopened: 0,
    };
    cell.runs.add(runId);
    if (measured.has(runId)) {
      cell.measured.add(runId);
    }
    cells.set(memberId, cell);
    return cell;
  };
  const ours = <T extends { runId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => runIds.has(row.runId));

  for (const turn of ours(input.turns)) {
    if (turn.memberId !== null) {
      cellOf(turn.memberId, turn.runId);
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

  const folded = new Map<string, MemberWork>();
  for (const [memberId, cell] of cells) {
    const counted = cell.goals.recorded - cell.goals.dropped;
    folded.set(memberId, {
      runs: cell.runs.size,
      work:
        cell.measured.size === 0
          ? null
          : {
              measuredRuns: cell.measured.size,
              callsAnswered: cell.callsAnswered,
              callsFailed: cell.callsFailed,
              avgAnswerMs:
                cell.timedAnswers === 0
                  ? null
                  : Math.round(cell.answerMs / cell.timedAnswers),
              callsMade: cell.callsMade,
              toolCalls: cell.toolCalls,
              toolErrors: cell.toolErrors,
              goals: {
                ...cell.goals,
                achievedShare:
                  counted === 0 ? null : cell.goals.achieved / counted,
              },
              stagesCompleted: cell.stagesCompleted,
              completionsReopened: cell.completionsReopened,
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
    });
    byMember.set(row.memberId, list);
  }
  return byMember;
}
