import { sep } from 'node:path';

/** The directory every task worktree is cut under — `<userData>/worktrees`. */
const WORKTREES_SEGMENT = 'worktrees';

/**
 * The task id a folder COULD be the worktree of: the path segment right after a
 * `worktrees` directory, or null when the path has none.
 *
 * Task worktrees are `<userData>/worktrees/<taskId>` (the Electron main process
 * cuts them — `main/worktree-service.ts`). The userData directory is NOT
 * matched: a dev profile and the installed app keep different ones, and the
 * ledger holds rows from whichever ran the turn. So this only names a
 * CANDIDATE, and the caller confirms it against the tasks table — a task id is
 * a UUID, so a folder that merely sits under some other `worktrees` directory
 * names no task and stays itself.
 */
export function taskIdOfWorktree(cwd: string): string | null {
  const parts = cwd.split(sep);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (parts[i] === WORKTREES_SEGMENT && parts[i + 1] !== '') {
      return parts[i + 1] ?? null;
    }
  }
  return null;
}
