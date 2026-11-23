import { z } from 'zod';

import {
  type RunGoal,
  RunGoalSchema,
  type StoredThreadOutcome,
  StoredThreadOutcomeSchema,
  type ThreadOutcome,
  type ThreadOutcomeKind,
} from '../chat.types';
import { parseJsonColumn } from './json-util';

const RunGoalsColumnSchema = z.array(RunGoalSchema);

export function writeRunGoals(goals: readonly RunGoal[]): string {
  return JSON.stringify(goals);
}

/** A run's goals column; an unreadable one reads as none. */
export function readRunGoals(column: string | null): RunGoal[] {
  if (column === null) {
    return [];
  }
  const parsed = RunGoalsColumnSchema.safeParse(parseJsonColumn(column));
  return parsed.success ? parsed.data : [];
}

export function writeThreadOutcome(outcome: StoredThreadOutcome): string {
  return JSON.stringify(outcome);
}

export function readThreadOutcome(
  column: string | null,
): StoredThreadOutcome | null {
  if (column === null) {
    return null;
  }
  const parsed = StoredThreadOutcomeSchema.safeParse(parseJsonColumn(column));
  return parsed.success ? parsed.data : null;
}

/**
 * The outcome goals alone say, once every goal is closed: of the goals not
 * dropped, all achieved is success, some partial, none failed. Null while a goal
 * is still open — the thread has not ended by its goals — and when none counts.
 */
export function outcomeKindFromGoals(
  goals: readonly Pick<RunGoal, 'status'>[],
): ThreadOutcomeKind | null {
  const counted = goals.filter((goal) => goal.status !== 'dropped');
  if (counted.length === 0 || counted.some((goal) => goal.status === 'open')) {
    return null;
  }
  const achieved = counted.filter((goal) => goal.status === 'achieved').length;
  if (achieved === counted.length) {
    return 'success';
  }
  return achieved > 0 ? 'partial' : 'failed';
}

/**
 * Whether a recorded success contradicts the goals: a goal not dropped is
 * still open or was closed not achieved. Only a recorded outcome can diverge.
 */
export function outcomeDivergesFromGoals(
  outcome: Pick<StoredThreadOutcome, 'kind' | 'source'>,
  goals: readonly Pick<RunGoal, 'status'>[],
): boolean {
  return (
    outcome.source === 'recorded' &&
    outcome.kind === 'success' &&
    goals.some(
      (goal) => goal.status !== 'dropped' && goal.status !== 'achieved',
    )
  );
}

/** A thread's served outcome: the recorded one, else the one its goals derive. */
export function threadOutcomeOf(
  recorded: StoredThreadOutcome | null,
  goals: readonly Pick<RunGoal, 'status'>[],
): ThreadOutcome | null {
  if (recorded !== null) {
    return {
      ...recorded,
      divergesFromGoals: outcomeDivergesFromGoals(recorded, goals),
    };
  }
  const kind = outcomeKindFromGoals(goals);
  return kind === null
    ? null
    : {
        kind,
        summary: null,
        source: 'goals',
        seq: null,
        divergesFromGoals: false,
      };
}
