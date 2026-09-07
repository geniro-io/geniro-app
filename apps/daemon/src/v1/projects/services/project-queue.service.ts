import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import type { ProjectQueue, QueuedTask } from '../projects.types';
import { isBreakerOpen } from '../utils/breaker';

/**
 * What one project's autopilot may start right now.
 *
 * The daemon answers this rather than the conductor working it out, because
 * the conductor can only see its own window. Two armed windows both polling
 * would each count their own runs and each start up to the cap — so the count
 * is taken here, over the rows, and the handout is already narrowed to the
 * slots that are actually free.
 *
 * That narrowing is not the whole guard and is not meant to be: a conductor
 * that ignored it, or two that polled in the same instant, are refused again
 * at the start route. This is the fast answer; that is the line.
 */
@Injectable()
export class ProjectQueueService {
  constructor(
    private readonly em: EntityManager,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly runDao: RunDao,
  ) {}

  async read(projectId: string): Promise<ProjectQueue> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);
    const tasks = await this.taskDao.listForProject(projectId, em);

    const running = await this.countRunning(tasks, em);
    const breakerOpen = isBreakerOpen(project);
    const free = Math.max(0, project.autopilotMaxConcurrent - running);
    const handOutWork = project.autopilotEnabled && !breakerOpen && free > 0;

    const waiting = tasks.filter(
      (task) => task.status === project.autopilotIntakeStatus,
    );

    return {
      projectId: project.id,
      enabled: project.autopilotEnabled,
      intakeStatus: project.autopilotIntakeStatus,
      cap: project.autopilotMaxConcurrent,
      running,
      waiting: waiting.length,
      breakerOpen,
      failureStreak: project.autopilotFailureStreak,
      eligible: handOutWork
        ? waiting
            .slice()
            .sort((a, b) => a.position - b.position)
            .slice(0, free)
            .map((task) => toQueued(task, project.folder))
        : [],
    };
  }

  /**
   * How many of this project's cards hold a run that is still live.
   *
   * Asked of the RUNS rather than counted off the `in_progress` column, for
   * the reason `TaskRunsService.assertNotAlreadyRunning` gives: a card dragged
   * out of `in_progress` by hand still points at the agent working it, and a
   * count that believed the column would hand out a slot that is not free.
   *
   * One query for every run at once — the alternative is a read per card, on a
   * path a timer walks for every armed project.
   */
  private async countRunning(
    tasks: readonly { runId: string | null }[],
    em: EntityManager,
  ): Promise<number> {
    const runIds = tasks
      .map((task) => task.runId)
      .filter((runId): runId is string => runId !== null);
    if (runIds.length === 0) {
      return 0;
    }
    const runs = await this.runDao.getAll(
      { id: { $in: runIds } },
      { disableIdentityMap: true },
      em,
    );
    return runs.filter((run) => !isTerminalRunStatus(run.status)).length;
  }

  private async require(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `project ${projectId} does not exist`,
      );
    }
    return project;
  }
}

function toQueued(
  task: {
    id: string;
    title: string;
    status: QueuedTask['status'];
    position: number;
    folder: string | null;
  },
  projectFolder: string,
): QueuedTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    position: task.position,
    // The inheritance is resolved HERE and nowhere downstream: the conductor
    // runs in the Electron process off this handout alone, and a second copy
    // of "null means the project's" is how the timer and the board come to cut
    // worktrees from two different repositories.
    folder: task.folder ?? projectFolder,
  };
}
