import { HOST_RECORD_OUTCOME_TOOL } from '../../../agents/chat.types';

/** What a model reads about `goals`. */
export function goalsInstructions(): string {
  return (
    "Record what this task is meant to achieve, and close each goal with the evidence of how it ended. The user sees the list beside the chat and edits it too, and the run's statistics count how many goals were achieved. " +
    'Use it at the start of a task: `set` a few goals — each one checkable outcome ("the export button saves a .csv", "the failing spec passes"), not a plan step; mark `source` user for what the user asked for, agent for what you inferred. ' +
    "When the task changes, `add`, `update` or `remove` open goals; `list` reads them, the user's edits included. " +
    'Before you finish, `complete` every goal: achieved, not_achieved or dropped, always with `evidence` — the test run, command, link or file that shows it, or why it was dropped. ' +
    'An unclosed goal counts as not achieved. ' +
    `Do not use it for your own step-by-step todo list (keep that in your CLI's own task list), and do not use it to report how the whole thread ended — that is ${HOST_RECORD_OUTCOME_TOOL}.`
  );
}
