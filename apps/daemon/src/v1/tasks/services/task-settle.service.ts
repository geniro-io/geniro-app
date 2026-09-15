import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectDao } from '../../projects/dao/project.dao';
import { isBreakerOpen } from '../../projects/utils/breaker';
import { isTerminalRunStatus, type RunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import type { TaskStatus, TaskWire } from '../tasks.types';
import { TasksService } from './tasks.service';

/**
 * Where a card that was being WORKED lands when its run ends in a way the agent
 * could not report itself.
 *
 * `completed` is deliberately absent. A run finishing is not the task being
 * finished — the agent says that itself, through `update_task`, together with
 * its report (`TaskBoardToolService`). Moving the card here on the run's own
 * ending is what put a thread's last message on the card as its "report",
 * which was whatever the agent happened to say last — an interim "waiting for
 * the check, then I'll open the PR" as readily as a conclusion.
 *
 * A failure and a cancel stay: an agent whose process died cannot call a tool,
 * and a user who pressed Stop has already decided. A cancel sends the card
 * back to the column it can be started from rather than marking it failed —
 * they did not fail at anything.
 */
const ENDED_TASK_STATUS: Partial<Record<RunStatus, TaskStatus>> = {
  failed: 'failed',
  cancelled: 'todo',
};

/**
 * What the board does when a task's run ends by itself.
 *
 * This module OBSERVES the agent plane and never drives it — the same shape
 * `v1/stats` takes, and for the same reason: `AgentEventBus` is where both
 * execution paths converge, so one subscription covers every way a run can
 * settle and nothing in `v1/agents` has to know that tasks exist.
 *
 * It no longer writes a report and no longer moves a card on success; both are
 * the agent's (see {@link ENDED_TASK_STATUS}). What is left is what an agent
 * cannot do for itself: park a card whose run failed or was stopped, keep the
 * autopilot's failure streak, and release a card whose run was deleted.
 */
@Injectable()
export class TaskSettleService implements OnModuleInit {
  private readonly logger = new Logger(TaskSettleService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.bus.allStatuses().subscribe((event) => {
      if (event.status === 'running') {
        void this.reviveFailedCard(event.runId).catch((error: unknown) => {
          this.logger.warn(
            `could not put the task for run ${event.runId} back to work: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        return;
      }
      // An announce carries a null status to say only what the run is DOING;
      // it asserts nothing about settling.
      if (event.status == null || !isTerminalRunStatus(event.status)) {
        return;
      }
      const status = event.status;
      // Detached rather than awaited: a rejection escaping an RxJS subscriber
      // becomes an unhandled rejection, and a board that cannot be updated
      // must not take the turn's own settle down with it.
      void this.settle(event.runId, status).catch((error: unknown) => {
        this.logger.warn(
          `could not settle the task for run ${event.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    this.bus.allDeleted().subscribe((runId) => {
      void this.releaseDeletedRun(runId).catch((error: unknown) => {
        this.logger.warn(
          `could not release the task holding deleted run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  /**
   * Put a FAILED card back to work when the run it failed on works again.
   *
   * A card's run is an ordinary chat, so a turn that errored is routinely
   * followed by the user carrying the conversation on IN THE CHAT — which goes
   * straight to `ChatService` and never through `TaskRunsService`, the path
   * that moves a card when the panel's Follow up is pressed. Without this the
   * card sat in `failed` for good under a conversation that went on to finish
   * cleanly. REPORTED on the card that asked for merged pull requests to end
   * in `done`, which its own recovered run could then never reach.
   *
   * ONLY `failed` is lifted: a card in review is one whose conversation the
   * user continues deliberately, and the agent moves it again itself if the
   * work reopens.
   */
  private async reviveFailedCard(runId: string): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    // A card that has since been started on a DIFFERENT run failed on that
    // one, not on this.
    if (!task || task.runId !== runId || task.status !== 'failed') {
      return;
    }
    await this.tasks.moveStatus(task.id, { from: 'failed', to: 'in_progress' });
  }

  /**
   * Let go of a run that has been deleted out from under its card.
   *
   * A task's run is an ordinary chat, so it can be deleted from the chat
   * sidebar like any other — and the card holding it then names a run nothing
   * can answer for. Left alone it sits in `in_progress` for good with Run
   * disabled, because the button asks the RUN whether an agent is working and
   * a missing run is not a settled one.
   *
   * So the edge is cleared and a card that was being worked goes back to the
   * column it can be started from. The REPORT stays: it is stored on the card
   * and is the card's account of the work, not a pointer into the transcript.
   *
   * The WORKTREE is deliberately untouched — the branch and the directory are
   * main's, they outlive the conversation, and the agent's work is in them.
   */
  private async releaseDeletedRun(runId: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.findByRunId(runId, em);
    if (!task) {
      return;
    }
    await this.tasks.update(task.id, { runId: null });
    if (task.status === 'in_progress') {
      await this.tasks.moveStatus(task.id, {
        from: 'in_progress',
        to: 'todo',
      });
    }
  }

  /**
   * Reconcile one run's card against the run's stored status.
   *
   * The same call the subscription makes, exposed because the broadcast is the
   * one thing a closed app misses: a run that settles while no window is open
   * announces to nobody, so the card is reconciled from the row when the board
   * next loads it.
   */
  async settle(runId: string, status: RunStatus): Promise<void> {
    if (!isTerminalRunStatus(status)) {
      return;
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    // A card deleted while its agent worked, or one that has since been
    // started on a DIFFERENT run — an older run settling must not move a card
    // that has moved on from it.
    if (!task || task.runId !== runId) {
      return;
    }
    const worked = task.status === 'in_progress';
    await this.recordOutcome(task.projectId, status, worked, em);
    // A card in Done — the user's drag, or the agent's own `update_task` —
    // becomes FINISHED now: the run settling is the second of
    // `isWorkFinished`'s two conditions, and the first was met at the move,
    // which could not release the worktree while the agent still worked.
    if (task.status === 'done') {
      this.tasks.announceWorkFinished(task);
      return;
    }
    // Only a card still reading as worked is moved. The run is an ordinary
    // chat, so a follow-up after review settles it again — and a card the
    // agent or the user already moved must stay where they put it.
    const to = ENDED_TASK_STATUS[status];
    if (to === undefined || !worked) {
      return;
    }
    await this.tasks.moveStatus(task.id, { from: 'in_progress', to });
  }

  /**
   * Move the project's failure streak, which is what opens and closes the
   * breaker.
   *
   * Counted per PROJECT and kept on the row rather than in memory, because the
   * daemon may exit between two tasks — the idle window is measured in
   * minutes — and a breaker that forgot its count on every restart could never
   * reach a threshold at all.
   *
   * A CANCEL moves nothing in either direction: the user stopped their own
   * agent, which is neither a fault to count nor a success to clear one.
   *
   * A failure counts only on a card that was being WORKED, on a project that is
   * armed. The streak is a claim about unattended work: a follow-up turn
   * failing in a thread already in review is not a task failing, and a person
   * re-running something on a disarmed project is not building evidence for a
   * breaker that is guarding nothing. A SUCCESS clears it either way — the card
   * may well have been moved by its agent before the turn ended, and whatever
   * started the run, the thing works.
   */
  private async recordOutcome(
    projectId: string,
    status: RunStatus,
    worked: boolean,
    em: EntityManager,
  ): Promise<void> {
    if (status === 'cancelled') {
      return;
    }
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      return;
    }
    if (status === 'completed') {
      if (project.autopilotFailureStreak !== 0) {
        project.autopilotFailureStreak = 0;
        await em.flush();
      }
      return;
    }
    if (!worked || !project.autopilotEnabled) {
      return;
    }
    project.autopilotFailureStreak += 1;
    await em.flush();
    if (isBreakerOpen(project)) {
      this.logger.warn(
        `project ${project.id} has ${project.autopilotFailureStreak} failed runs in a row — the autopilot has stopped picking work up`,
      );
    }
  }

  /**
   * Catch one board up on runs that settled while nobody was listening.
   *
   * The broadcast is the one thing a closed app misses: a run that fails with
   * no window open announces to nobody, and the card is still drawn as
   * working when the board next loads. So the board asks for this on the way
   * in, and the run ROW answers — the same question the live path asks, put to
   * the durable copy instead of to an event that has already passed.
   *
   * Only a card that believes it is working is examined: everything else has
   * either already been settled or was never started from here.
   */
  async reconcileProject(projectId: string): Promise<TaskWire[]> {
    const em = this.em.fork();
    const tasks = await this.taskDao.listForProject(projectId, em);
    for (const task of tasks) {
      if (task.runId === null || task.status !== 'in_progress') {
        continue;
      }
      const run = await this.runDao.getById(task.runId, em);
      if (!run || !isTerminalRunStatus(run.status)) {
        continue;
      }
      // Per card, on the subscriber's own terms: `settle` ends in a
      // compare-and-set that throws when the row moved since it was read, and
      // `reconcileTasks` is the board's ONLY listing call — so one contested
      // card must not cost the user every other one.
      await this.settle(task.runId, run.status).catch((error: unknown) => {
        this.logger.warn(
          `could not reconcile task ${task.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return this.tasks.listForProject(projectId);
  }
}
