import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { asRecord, parseJsonColumn } from '../../agents/utils/json-util';
import { ProjectDao } from '../../projects/dao/project.dao';
import { isBreakerOpen } from '../../projects/utils/breaker';
import {
  isTerminalRunStatus,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
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
 * How a run ended, as far as its card is concerned: its status, or
 * `interrupted` — a `failed` run whose work was cut off by the DAEMON stopping
 * rather than by anything the agent or the user did.
 */
type RunEnding = RunStatus | 'interrupted';

/**
 * The rows the boot reconcile writes AFTER an interruption's closing `error`,
 * which {@link TaskSettleService.endedInterrupted} looks past to find it.
 *
 * `ChatService.reconcileOrphanedRuns` follows its error with `unanswerable`
 * rows, `GraphExecutorService.reconcileOrphanedRuns` adds a `status` per open
 * node turn and a `call_result` per open call, and the delegate and shell boot
 * sweeps that run after both close what the dead process left out. None of
 * them is the run carrying on; all of them are bookkeeping about how it
 * stopped.
 */
const INTERRUPTION_TRAILERS: readonly ItemKind[] = [
  'unanswerable',
  'status',
  'call_result',
  'subagent_info',
  'shell_info',
];

/**
 * Where an interrupted card waits to be picked up again, when the project's
 * intake column is not one a card can wait in.
 *
 * The intake column is a free choice in the autopilot's settings, and moving a
 * card to `done` would announce its work FINISHED and have its worktree
 * collected — so only the two waiting columns are honoured.
 */
const WAITING_COLUMNS: readonly TaskStatus[] = ['backlog', 'todo'];

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
 * cannot do for itself: park a card whose run failed or was stopped, put back
 * a card whose run the daemon's own shutdown cut off, keep the autopilot's
 * failure streak, and release a card whose run was deleted.
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
    /**
     * Read for one question only — whether a failed run's LAST word is the
     * boot reconcile's `interrupted` row (see {@link endedInterrupted}). The
     * run's status cannot say it: an interrupted run is closed `failed`.
     */
    private readonly itemDao: ItemDao,
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
   *
   * `from` says which of the two is asking, and it decides one thing only:
   * when the ending is COUNTED against the failure streak. An `event` is the
   * one announcement of this ending, so it counts. A `reconcile` re-reads a row
   * that has usually been counted already — see the note under the move.
   */
  async settle(
    runId: string,
    status: RunStatus,
    from: 'event' | 'reconcile' = 'event',
  ): Promise<void> {
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
    const ending: RunEnding =
      status === 'failed' && (await this.endedInterrupted(runId, em))
        ? 'interrupted'
        : status;
    if (from === 'event') {
      await this.recordOutcome(task.projectId, ending, worked, em);
    }
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
    //
    // An INTERRUPTED card goes back to where the autopilot picks work up. Not
    // to `failed` — the agent failed at nothing; the app was quit, or the
    // daemon died, under it — and not necessarily to the `todo` a Stop sends
    // a card to: a Stop parks the card for the user, while this one is meant
    // to be picked up again, so it goes to the project's intake column. Its
    // run reads `failed` rather than `cancelled`, so the queue does not list
    // it as stopped either. The next Run, pressed or the autopilot's,
    // CONTINUES its thread: the run is settled, so
    // `TaskRunsService.resumableRun` takes it like any other.
    const to =
      ending === 'interrupted'
        ? await this.intakeColumn(task.projectId, em)
        : ENDED_TASK_STATUS[ending];
    if (to === undefined || !worked) {
      return;
    }
    await this.tasks.moveStatus(task.id, { from: 'in_progress', to });
    // A reconcile counts an ending only when it is the one that MOVES the card.
    // It re-reads every card still in `in_progress` on every board load and
    // every `task_changed`, and a card whose run COMPLETED is never moved here
    // (its agent moves it), so counting on that path cleared the streak again
    // on each load — an open board kept the breaker from ever tripping while
    // other cards failed. The move is also what makes the count happen once:
    // the card leaves `in_progress`, so no later load reads this run again.
    // After the move rather than before it, so two boards reconciling at once
    // count only the one whose compare-and-set won.
    if (from === 'reconcile') {
      await this.recordOutcome(task.projectId, ending, worked, em);
    }
  }

  /**
   * Whether this run's last word is the boot reconcile saying it was cut off —
   * the `error` row carrying `interrupted: true` that
   * `ChatService.reconcileOrphanedRuns` and
   * `GraphExecutorService.reconcileOrphanedRuns` write for a run the daemon
   * stopped under (a SIGKILL, or a shutdown, which leaves a working run
   * `running` on purpose so that it is closed this way).
   *
   * The LAST word, not merely the newest error: a thread continued after an
   * interruption and then failed for real has moved on from it, so the newest
   * row that is not one of the reconcile's own trailers
   * ({@link INTERRUPTION_TRAILERS}) has to BE that error. One indexed query
   * for one row.
   */
  private async endedInterrupted(
    runId: string,
    em: EntityManager,
  ): Promise<boolean> {
    const last = await this.itemDao.getOne(
      { runId, kind: { $nin: [...INTERRUPTION_TRAILERS] } },
      { orderBy: { seq: 'desc' }, disableIdentityMap: true },
      em,
    );
    return (
      last?.kind === 'error' &&
      asRecord(parseJsonColumn(last.payload))?.interrupted === true
    );
  }

  /**
   * The column an interrupted card goes back to: the one the project's
   * autopilot picks work up from, when a card can wait there — see
   * {@link WAITING_COLUMNS}.
   */
  private async intakeColumn(
    projectId: string,
    em: EntityManager,
  ): Promise<TaskStatus> {
    const intake = (await this.projectDao.getById(projectId, em))
      ?.autopilotIntakeStatus;
    return intake !== undefined && WAITING_COLUMNS.includes(intake)
      ? intake
      : 'todo';
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
   * agent, which is neither a fault to count nor a success to clear one. Nor
   * does an INTERRUPTION, for the same reason from the other side: the daemon
   * stopping under the agent says nothing about the work — counted, quitting
   * the app three times during runs would switch the autopilot off.
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
    ending: RunEnding,
    worked: boolean,
    em: EntityManager,
  ): Promise<void> {
    if (ending === 'cancelled' || ending === 'interrupted') {
      return;
    }
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      return;
    }
    if (ending === 'completed') {
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
   *
   * A null project is the board of EVERY project, which is what the board
   * shows with no project picked.
   */
  async reconcileProject(projectId: string | null): Promise<TaskWire[]> {
    const em = this.em.fork();
    const tasks =
      projectId === null
        ? await this.taskDao.listAll(em)
        : await this.taskDao.listForProject(projectId, em);
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
      await this.settle(task.runId, run.status, 'reconcile').catch(
        (error: unknown) => {
          this.logger.warn(
            `could not reconcile task ${task.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
    }
    return projectId === null
      ? this.tasks.listAll()
      : this.tasks.listForProject(projectId);
  }
}
