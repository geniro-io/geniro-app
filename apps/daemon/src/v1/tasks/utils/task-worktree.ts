import { join } from 'node:path';

import { ownDataDirPath } from '../../agents/utils/own-data-dir';

/**
 * TWIN: `WORKTREES_DIR_NAME` and `worktreesRoot` in
 * `apps/ui/src/main/worktree-service.ts`, which makes every card's worktree at
 * `<userData>/worktrees/<taskId>`. Change one and change the other.
 */
export const TASK_WORKTREES_DIR_NAME = 'worktrees';

export function taskWorktreesRoot(): string {
  return ownDataDirPath(TASK_WORKTREES_DIR_NAME);
}

/**
 * Where a card's run works: its worktree when the start names the branch main
 * checked out there, else the folder itself, which is in no git repository.
 */
export function taskRunFolder(
  task: { id: string; folder: string | null },
  projectFolder: string,
  branch: string | undefined,
  worktreesRoot: string,
): string {
  return branch === undefined
    ? (task.folder ?? projectFolder)
    : join(worktreesRoot, task.id);
}
