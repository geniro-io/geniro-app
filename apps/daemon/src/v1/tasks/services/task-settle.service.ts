import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { terminalNodeIds } from '../../graphs/utils/graph-order';
import { ProjectDao } from '../../projects/dao/project.dao';
import { isBreakerOpen } from '../../projects/utils/breaker';
import type { Run } from '../../runs/entity/run.entity';
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
    private readonly projectDao: ProjectDao,
    private readonly tasks: TasksService,
    private readonly workflows: WorkflowStoreService,
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
   * Let go of a run that has been deleted out from under its card.
   *
   * A task's run is an ordinary chat, so it can be deleted from the chat
   * sidebar like any other — and the card holding it then names a run nothing
   * can answer for. Left alone it sits in `in_progress` for good with Run
   * disabled, because the button asks the RUN whether an agent is working and
   * a missing run is not a settled one.
   *
   * So the edge is cleared and a card that was being worked goes back to the
   * column it can be started from. Its report reference goes with it: the row
   * it named was hard-deleted with the transcript, so keeping the id would
   * leave the detail panel fetching a report that cannot exist.
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
    await this.tasks.update(task.id, { runId: null, reportItemId: null });
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
    // A card the user called Done while its agent was still working becomes
    // FINISHED now — the run settling is the second of `isWorkFinished`'s two
    // conditions, and the first was met at the drag, which could not release
    // the worktree then. The card itself stays where the user put it.
    if (task.status === 'done') {
      this.tasks.announceWorkFinished(task);
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

    const reportItemId = await this.findReport(run, em);
    if (reportItemId !== null) {
      await this.tasks.update(task.id, { reportItemId });
    }
    await this.recordOutcome(task.projectId, status, em);
    // No reason rides this move. A card in review is NOT finished: the user
    // reads the work in its worktree and routinely continues the conversation,
    // so the directory has to outlive the settle — see `isWorkFinished`.
    await this.tasks.moveStatus(task.id, { from: task.status, to });
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
   * A failure counts only while the project is armed. The streak is a claim
   * about unattended work, and a person deliberately re-running something they
   * know is broken, on a project they have already disarmed, is not building
   * evidence for a breaker that is not guarding anything. A SUCCESS clears it
   * either way — whatever the run was started by, the thing works.
   */
  private async recordOutcome(
    projectId: string,
    status: RunStatus,
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
    if (!project.autopilotEnabled) {
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
   *
   * A WORKFLOW run narrows both lookups to the graph's TERMINAL nodes, and that
   * is not a refinement — it is what makes the answer mean anything. A chat has
   * one voice, so its highest-`seq` message is its conclusion; a graph is N
   * nodes writing into one stream, so the same query returns whichever node of
   * a fan-out finished last. `report_findings` is only ever sought on the
   * chance a node had the tool by another route (a caller node holds an MCP
   * endpoint), which is why the workflow variant of the instructions does not
   * name it.
   */
  private async findReport(
    run: Pick<Run, 'id' | 'workflowId'>,
    em: EntityManager,
  ): Promise<string | null> {
    const nodeIds = await this.terminalNodesOf(run.workflowId);
    const found = await this.findReportAmong(run.id, nodeIds, em);
    if (found !== null || nodeIds === undefined) {
      return found;
    }
    // The workflow can be edited between this run finishing and its card
    // settling, moving its terminal node ids — a stale set matches no row of
    // this run just as an absent one would, so the filtered miss falls back
    // to the unfiltered read rather than reporting no result at all.
    return this.findReportAmong(run.id, undefined, em);
  }

  private async findReportAmong(
    runId: string,
    nodeIds: string[] | undefined,
    em: EntityManager,
  ): Promise<string | null> {
    const findings = await this.itemDao.latestOfKind(
      runId,
      'report_findings',
      undefined,
      em,
      nodeIds,
    );
    if (findings) {
      return findings.id;
    }
    const message = await this.itemDao.latestOfKind(
      runId,
      'message',
      'assistant',
      em,
      nodeIds,
    );
    return message?.id ?? null;
  }

  /**
   * Which nodes of a workflow are its conclusion, or undefined for a chat run
   * and for anything this cannot answer.
   *
   * Undefined means "no node filter", which is the honest degrade: a workflow
   * whose YAML has since been edited, renamed or deleted still settled a real
   * card, and the last message of an unknown shape is a better report than
   * none. Reading TODAY's definition is the same approximation `HandoffService`
   * makes for a legacy node, and it is safe here because the answer is only
   * ever used to PREFER one row over another.
   */
  private async terminalNodesOf(
    workflowId: string | null,
  ): Promise<string[] | undefined> {
    if (workflowId === null) {
      return undefined;
    }
    try {
      const { workflow } = await this.workflows.get(workflowId);
      const ids = terminalNodeIds(workflow.nodes, workflow.edges);
      // An empty set would match no row at all, turning "we could not tell
      // which node concludes" into "this run produced no report".
      return ids.size === 0 ? undefined : [...ids];
    } catch (error) {
      this.logger.warn(
        `could not read workflow ${workflowId} to find its terminal nodes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }
}
