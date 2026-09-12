import { type DaemonApis, daemonErrorCode } from '../daemon-api';

/**
 * Whether the daemon refused a turn because the run's folder is not there.
 *
 * Read off the daemon's named code rather than its sentence (`cwd does not
 * exist: …`), for the reason `daemonErrorCode` gives: the sentence is prose,
 * and a folder whose own path contains the words would match it.
 */
export function isMissingCwdError(err: unknown): boolean {
  return daemonErrorCode(err) === 'INVALID_CWD';
}

/**
 * Put a task's worktree back, so the chat working in it can carry on.
 *
 * A task's worktree is collected once its card is Done and nothing is working
 * in it — but its chat is still an ordinary conversation, and a message sent
 * into it afterwards was refused `cwd does not exist` with no way forward:
 * REPORTED over a transcript whose every later message failed that way. The
 * BRANCH outlives the directory by design, so main cuts the same path again
 * from it (`prepareWorktree` re-uses a branch that exists) and every commit the
 * agent made is there; when the follow-up settles under the still-Done card,
 * the daemon says the work is finished again and the board collects it again.
 *
 * The folder is the one a Run press resolves: the card's own, else its
 * project's. False on ANY failure — the caller then shows the daemon's own
 * refusal, which is the true answer to what happened.
 */
export async function restoreTaskWorktree(
  apis: Pick<DaemonApis, 'tasks' | 'projects'>,
  taskId: string,
): Promise<boolean> {
  try {
    const task = await apis.tasks.readTask({ taskId });
    const folder =
      task.folder ??
      (await apis.projects.readProject({ projectId: task.projectId })).folder;
    const made = await window.geniro.prepareTaskWorktree({ taskId, folder });
    return made.ok;
  } catch {
    return false;
  }
}

/**
 * Run `send`; when the daemon refuses it because a TASK run's folder is gone,
 * put the worktree back and send ONCE more.
 *
 * Once, because the only refusal this answers is the one a restore can fix —
 * a second refusal after a successful restore is some other problem, and the
 * caller shows it. A chat that is not a task's has no worktree of geniro's to
 * restore, so its refusal is rethrown untouched.
 */
export async function sendRestoringWorktree<T>(
  send: () => Promise<T>,
  taskId: string | null,
  restore: (taskId: string) => Promise<boolean>,
): Promise<T> {
  try {
    return await send();
  } catch (err: unknown) {
    if (
      taskId === null ||
      !isMissingCwdError(err) ||
      !(await restore(taskId))
    ) {
      throw err;
    }
    return send();
  }
}
