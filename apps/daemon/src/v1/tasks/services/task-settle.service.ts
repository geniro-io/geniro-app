import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { isTerminalRunStatus, type RunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import type { TaskStatus, TaskWire } from '../tasks.types';
import { TasksService } from './tasks.service';

/**
 * Where a card lands when the run working it settles.
 *
 * A cancel is the user stopping their own agent, so the card goes back to the
 * column it can be started from again rather than being marked failed — they
 * did not fail at anything.
 */
const SETTLED_TASK_STATUS: Record<RunStatus, TaskStatus | null> = {
  pending: null,
  running: null,
  completed: 'in_review',
  failed: 'failed',
  cancelled: 'todo',
};

/**
 * Moving a card when its agent finishes, and recording what the agent said.
 *
 * This module OBSERVES the agent plane and never drives it — the same shape
 * `v1/stats` takes, and for the same reason: `AgentEventBus` is where both
 * execution paths converge, so one subscription covers every way a run can
 * settle and nothing in `v1/agents` has to know that tasks exist.
 *
 * The report is read from the TRANSCRIPT rather than from the event that
 * announced the settle, and that is what makes the live path and the
 * app-was-closed path one piece of code. `writeRunStatus` persists the status
 * column alone, so `RunStatusEvent.summary` — the agent's closing words —
 * exists only for as long as that event is in flight. The rows outlive it, and
 * persist-then-emit means they are already written when it arrives.
 */
@Injectable()
export class TaskSettleService implements OnModuleInit {
  private readonly logger = new Logger(TaskSettleService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.bus.allStatuses().subscribe((event) => {
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
    const to = SETTLED_TASK_STATUS[status];
    if (to === null) {
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
    // Settle a card ONCE. The run is an ordinary chat, so a follow-up message
    // after review settles it again — and without this, a card the user had
    // moved to `done` would be dragged back to `in_review` by a conversation
    // they deliberately continued. Only a card still reading as worked is a
    // card this has anything to say about.
    if (task.status !== 'in_progress') {
      return;
    }

    const reportItemId = await this.findReport(runId, em);
    if (reportItemId !== null) {
      await this.tasks.update(task.id, { reportItemId });
    }
    await this.tasks.moveStatus(task.id, { from: task.status, to });
  }

  /**
   * Catch one board up on runs that settled while nobody was listening.
   *
   * The broadcast is the one thing a closed app misses: a run that finishes
   * with no window open announces to nobody, and the card is still drawn as
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

  /**
   * The transcript row holding this run's closing report.
   *
   * A structured `report_findings` first, because that is what the run was
   * asked for and it renders as a report rather than as prose. The agent's
   * last message is the fallback — an agent that could not call the tool still
   * finished by saying what it did, and a card with no report at all is the
   * outcome worth avoiding.
   */
  private async findReport(
    runId: string,
    em: EntityManager,
  ): Promise<string | null> {
    const findings = await this.itemDao.latestOfKind(
      runId,
      'report_findings',
      undefined,
      em,
    );
    if (findings) {
      return findings.id;
    }
    const message = await this.itemDao.latestOfKind(
      runId,
      'message',
      'assistant',
      em,
    );
    return message?.id ?? null;
  }
}
