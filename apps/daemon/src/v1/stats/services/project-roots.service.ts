import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { mainRepositoryOfWorktree } from '../../agents/utils/repository-root';
import { Project } from '../../projects/entity/project.entity';
import { Task } from '../../tasks/entity/task.entity';
import { taskIdOfWorktree } from '../utils/task-worktree';

/**
 * Which PROJECT a folder's spend belongs to — the folder itself, unless it is
 * a git worktree, in which case the repository the worktree was cut from.
 *
 * REPORTED as "By project includes worktrees — it should not count a worktree
 * as a project": every board card runs in a worktree of its own, so one
 * repository's work was spread over a row per task, each named after a task id
 * (`…/worktrees/ce106990-b213-…`), and the repository's own row understated
 * what it cost.
 *
 * Two readings, first match wins, because a worktree is routinely GONE by the
 * time anybody looks at its spend — the board removes a task's worktree once
 * the card is done — so its `.git` pointer cannot be read any more:
 *
 * 1. a geniro TASK worktree (`<userData>/worktrees/<taskId>`) is its card's
 *    folder, or its project's when the card names none — read off the rows,
 *    soft-deleted ones included, so a finished card still answers. A folder
 *    is one only when the task it names EXISTS (`taskIdOfWorktree` names a
 *    candidate). Measured on a real ledger: $7,226 spread over 66 such rows;
 * 2. any other folder that is a linked worktree ON DISK is its main
 *    repository (`mainRepositoryOfWorktree`), and anything else is itself —
 *    an ordinary subfolder of a repository is deliberately NOT folded into
 *    the repository's root.
 *
 * Read at READ time rather than stored on the ledger row, so every row ever
 * written — and every one written before this existed — is filed the same
 * way. Each folder is resolved once per daemon: a worktree's repository never
 * changes, and the answers are a handful of strings.
 */
@Injectable()
export class ProjectRootsService {
  private readonly known = new Map<string, string>();

  constructor(private readonly em: EntityManager) {}

  /** The project of every folder asked about, keyed by that folder. */
  async rootsOf(
    cwds: Iterable<string | null>,
  ): Promise<ReadonlyMap<string, string>> {
    const pending = [...new Set(cwds)].filter(
      (cwd): cwd is string => cwd !== null && !this.known.has(cwd),
    );
    if (pending.length > 0) {
      const taskFolders = await this.taskFolders(pending);
      for (const cwd of pending) {
        this.known.set(cwd, await this.resolve(cwd, taskFolders));
      }
    }
    return this.known;
  }

  private async resolve(
    cwd: string,
    taskFolders: ReadonlyMap<string, string>,
  ): Promise<string> {
    const taskId = taskIdOfWorktree(cwd);
    const taskFolder = taskId === null ? undefined : taskFolders.get(taskId);
    if (taskFolder !== undefined) {
      return taskFolder;
    }
    return (await mainRepositoryOfWorktree(cwd)) ?? cwd;
  }

  /**
   * The folder each task worktree among `cwds` worked on, by task id. One read
   * for the tasks and one for their projects, past the soft-delete filter —
   * a card deleted since still names the repository its spend belongs to.
   */
  private async taskFolders(
    cwds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        cwds
          .map((cwd) => taskIdOfWorktree(cwd))
          .filter((id): id is string => id !== null),
      ),
    ];
    const folders = new Map<string, string>();
    if (ids.length === 0) {
      return folders;
    }
    const em = this.em.fork();
    const tasks = await em.find(
      Task,
      { id: { $in: ids } },
      { fields: ['id', 'projectId', 'folder'], filters: false },
    );
    const projects = new Map(
      (
        await em.find(
          Project,
          { id: { $in: [...new Set(tasks.map((task) => task.projectId))] } },
          { fields: ['id', 'folder'], filters: false },
        )
      ).map((project) => [project.id, project.folder]),
    );
    for (const task of tasks) {
      const folder = task.folder ?? projects.get(task.projectId) ?? null;
      if (folder !== null) {
        folders.set(task.id, folder);
      }
    }
    return folders;
  }
}
