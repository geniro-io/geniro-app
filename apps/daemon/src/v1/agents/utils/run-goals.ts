import { z } from 'zod';

import {
  type RunGoal,
  RunGoalSchema,
  type ThreadOutcome,
  type ThreadOutcomeKind,
  ThreadOutcomeSchema,
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

export function writeThreadOutcome(outcome: ThreadOutcome): string {
  return JSON.stringify(outcome);
}

export function readThreadOutcome(column: string | null): ThreadOutcome | null {
  if (column === null) {
    return null;
  }
  const parsed = ThreadOutcomeSchema.safeParse(parseJsonColumn(column));
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

/** A thread's served outcome: the recorded one, else the one its goals derive. */
export function threadOutcomeOf(
  recorded: ThreadOutcome | null,
  goals: readonly Pick<RunGoal, 'status'>[],
): ThreadOutcome | null {
  if (recorded !== null) {
    return recorded;
  }
  const kind = outcomeKindFromGoals(goals);
  return kind === null
    ? null
    : { kind, summary: null, source: 'goals', seq: null };
}
