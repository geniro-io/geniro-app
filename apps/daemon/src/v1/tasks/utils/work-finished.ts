import { isTerminalRunStatus, type RunStatus } from '../../runs/runs.types';
import type { TaskStatus } from '../tasks.types';

/**
 * Whether the work on a card is FINISHED — the one moment its worktree may be
 * collected.
 *
 * TWO conditions, and neither is enough alone. A settled RUN is not finished
 * work: a task's run is an ordinary chat, so the user continues it after
 * review, Retry re-sends into it, and the CLI opens a turn of its own when a
 * background command it started reports back — every one of which needs the
 * directory the chat runs in. Collecting at the settle is what took a live
 * conversation's cwd out from under it (REPORTED: the CLI's own continuation
 * turn failing in 0ms, then `cwd does not exist` on every message after it),
 * and with it everything the agent had produced that no commit holds — the
 * gitignored screenshots its galleries pointed at. And a card in DONE is not
 * finished while its agent is still working: the board writes the column the
 * moment a card is dragged.
 *
 * So the user has called the card Done AND nothing is working in it.
 * `runStatus` is null for a card with no run, or one whose run row is gone.
 */
export function isWorkFinished(
  status: TaskStatus,
  runStatus: RunStatus | null,
): boolean {
  return (
    status === 'done' && (runStatus === null || isTerminalRunStatus(runStatus))
  );
}
