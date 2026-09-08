import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import type { ActiveTask, ProjectQueueRaw } from '../projects.types';
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
 *
 * This service answers RAW state only — it does not decide which waiting
 * cards may actually start. See `ProjectQueueRaw`'s own doc for why that
 * split moved to `TaskQueueService`.
 */
@Injectable()
export class ProjectQueueService {
  constructor(
    private readonly em: EntityManager,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly runDao: RunDao,
  ) {}

  async readRaw(projectId: string): Promise<ProjectQueueRaw> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);
    const tasks = await this.taskDao.listForProject(projectId, em);

    const active = await this.readActive(tasks, em);
    const running = active.length;
    const breakerOpen = isBreakerOpen(project);
    const freeSlots = Math.max(0, project.autopilotMaxConcurrent - running);
    const handOutWork =
      project.autopilotEnabled && !breakerOpen && freeSlots > 0;

    const waitingTasks = tasks.filter(
      (task) => task.status === project.autopilotIntakeStatus,
    );

    return {
      projectId: project.id,
      enabled: project.autopilotEnabled,
      intakeStatus: project.autopilotIntakeStatus,
      cap: project.autopilotMaxConcurrent,
      running,
      waiting: waitingTasks.length,
      breakerOpen,
      failureStreak: project.autopilotFailureStreak,
      active,
      folder: project.folder,
      agentKind: project.agentKind,
      model: project.model,
      effort: project.effort,
      approval: project.approval,
      configDir: project.configDir,
      workflowSlug: project.workflowSlug,
      waitingTasks,
      freeSlots,
      handOutWork,
    };
  }

  /**
   * Which of this project's cards hold a run that is still live.
   *
   * Asked of the RUNS rather than read off the `in_progress` column, for the
   * reason `TaskRunsService.assertNotAlreadyRunning` gives: a card dragged out
   * of `in_progress` by hand still points at the agent working it, and a count
   * that believed the column would hand out a slot that is not free.
   *
   * It returns the LIST rather than a count because the board needs both, and
   * one query answering both is what keeps them from disagreeing — a card
   * drawn with a spinner while the header counts one fewer is the same class
   * of defect as the `waiting` that counted refused cards.
   *
   * One query for every run at once — the alternative is a read per card, on a
   * path a timer walks for every armed project.
   */
  private async readActive(
    tasks: readonly { id: string; runId: string | null }[],
    em: EntityManager,
  ): Promise<ActiveTask[]> {
    const byRunId = new Map(
      tasks
        .filter((task) => task.runId !== null)
        .map((task) => [task.runId as string, task.id]),
    );
    if (byRunId.size === 0) {
      return [];
    }
    const runs = await this.runDao.getAll(
      { id: { $in: [...byRunId.keys()] } },
      { disableIdentityMap: true },
      em,
    );
    const active: ActiveTask[] = [];
    for (const run of runs) {
      const taskId = byRunId.get(run.id);
      if (taskId === undefined || isTerminalRunStatus(run.status)) {
        continue;
      }
      // The RUN's own kind, not the card's: the card may have been re-pointed
      // at another agent since, and what is on screen is what is working.
      active.push({ id: taskId, runId: run.id, agentKind: run.agentKind });
    }
    return active;
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
