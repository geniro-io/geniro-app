import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { StartTaskRun, TaskWire } from '../tasks.types';
import {
  composeTaskPrompt,
  TASK_REPORT_INSTRUCTIONS,
} from '../utils/task-prompt';
import { TasksService } from './tasks.service';

/**
 * Starting an agent on a task.
 *
 * The card is what the user presses; an ordinary CHAT is what runs. That is
 * the whole design — a task run is not a second execution path, it is
 * `ChatService` called with a worktree as its cwd, which is why this module
 * imports `AgentsModule` rather than growing an engine of its own.
 *
 * It runs no git. The worktree and the branch arrive already made, from the
 * Electron main process, because every git call in this app belongs there.
 */
@Injectable()
export class TaskRunsService {
  private readonly logger = new Logger(TaskRunsService.name);

  /**
   * Tasks whose start is in flight, claimed synchronously.
   *
   * `TasksService.moveStatus` is a compare-and-set, and it is what stops two
   * BOARDS double-starting one card — but it reads and then writes with an
   * await between, so two requests arriving together can both find the card in
   * `todo` and both pass. `ChatService.sendMessage` closes the identical
   * window with the identical mechanism, and its reasoning applies unchanged:
   * reserve before the first await, since the cost of losing the race is two
   * agents in two worktrees working one task.
   */
  private readonly starting = new Set<string>();

  /**
   * One project's starts, serialized.
   *
   * The `starting` Set above stops one CARD being started twice; this stops
   * one PROJECT exceeding its cap, which is a different race and is not
   * covered by it. Two conductors picking two DIFFERENT eligible tasks both
   * count the running runs, both find a slot free, and both start — the cap is
   * exceeded without either card being touched twice, so neither the Set nor
   * the status compare-and-set can see it.
   *
   * In-process serialization is sufficient because there is exactly one
   * daemon per userData dir, which `utils/instance-lock.ts` enforces — every
   * window's conductor reaches this one map. A second daemon would defeat it,
   * and is refused at boot for its own reasons.
   */
  private readonly perProject = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
    private readonly chats: ChatService,
    private readonly queue: ProjectQueueService,
  ) {}

  async start(taskId: string, input: StartTaskRun): Promise<TaskWire> {
    if (this.starting.has(taskId)) {
      throw new ConflictException(
        'TASK_RUN_STARTING',
        `task ${taskId} is already starting a run`,
      );
    }
    this.starting.add(taskId);
    try {
      const projectId = await this.projectIdOf(taskId);
      return await this.queued(projectId, () =>
        this.startClaimed(taskId, input),
      );
    } finally {
      this.starting.delete(taskId);
    }
  }

  /**
   * Run `fn` after every start already queued for this project.
   *
   * The chain is kept on failures too — a start that threw still finished, and
   * dropping the tail there would let the next caller run beside one still in
   * flight. The entry is deleted only when this call is still the tail, so a
   * later start that has already chained onto it is never orphaned.
   */
  private async queued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.perProject.get(projectId) ?? Promise.resolve();
    const mine = prior.then(fn, fn);
    this.perProject.set(
      projectId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await mine;
    } finally {
      const tail = this.perProject.get(projectId);
      if (tail !== undefined) {
        void tail.then(() => {
          if (this.perProject.get(projectId) === tail) {
            this.perProject.delete(projectId);
          }
        });
      }
    }
  }

  private async projectIdOf(taskId: string): Promise<string> {
    const em = this.em.fork();
    return (await this.require(taskId, em)).projectId;
  }

  private async startClaimed(
    taskId: string,
    input: StartTaskRun,
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    const project = await this.requireProject(task.projectId, em);
    const agentKind = input.agentKind ?? project.agentKind;
    if (agentKind === null || agentKind === undefined) {
      throw new BadRequestException(
        'TASK_RUN_NO_AGENT',
        `neither this request nor project ${project.id} names an agent to run`,
      );
    }
    await this.assertNotAlreadyRunning(task, em);
    await this.assertAutopilotMayStart(project, input);

    // The MOVE is the reservation, which is why it happens before the chat
    // exists rather than after: a card sitting in `in_progress` is what a
    // second board's start is refused against. Everything after it is undone
    // by `abandon` if the run cannot be made.
    await this.tasks.moveStatus(taskId, {
      from: input.from,
      to: 'in_progress',
    });

    // Held so `abandon` can take the run down with the rest. Without it a
    // failure after creation leaves a chat whose `taskId` points at a card that
    // no longer names it, working directory already pruned by the caller.
    let runId: string | null = null;
    try {
      const run = await this.chats.createChat({
        agentKind,
        cwd: input.cwd,
        startSha: input.startSha,
        startDirty: input.startDirty,
        model: input.model ?? project.model ?? undefined,
        effort: input.effort ?? project.effort ?? undefined,
        approval: input.approval ?? project.approval ?? undefined,
        configDir: input.configDir ?? project.configDir ?? undefined,
        customInstructions: this.composeInstructions(input.customInstructions),
        // The card's own title, so the thread is findable in a sidebar that
        // lists it beside every other conversation. `ChatTitleService` leaves
        // a titled run alone, so this is not overwritten later.
        title: task.title,
        taskId: task.id,
        // The PROJECT's group rather than the folder rule: the run works in a
        // worktree, a path nothing has ever been filed under.
        groupId: project.groupId,
      });

      runId = run.id;
      const wire = await this.tasks.update(taskId, {
        runId: run.id,
        branch: input.branch,
        worktreePath: input.cwd,
      });

      await this.chats.sendMessage(run.id, composeTaskPrompt(task));
      return wire;
    } catch (error) {
      await this.abandon(taskId, input.from, runId);
      throw error;
    }
  }

  /**
   * Put the card back where the press found it.
   *
   * Its own failure is swallowed: the caller is owed the error that actually
   * stopped the run, and a card someone else moved in the meantime is not this
   * request's to drag back.
   */
  private async abandon(
    taskId: string,
    from: Task['status'],
    runId: string | null,
  ): Promise<void> {
    try {
      // The CARD first. Everything here is best-effort, and of the two the card
      // is what a user can be stuck on: left in `in_progress` it is refused by
      // the very guard that protects a live run, so a failure while cleaning up
      // would cost them the ability to start it again.
      await this.tasks.update(taskId, {
        runId: null,
        branch: null,
        worktreePath: null,
      });
      await this.tasks.moveStatus(taskId, { from: 'in_progress', to: from });
    } catch (error) {
      this.logger.warn(
        `could not return task ${taskId} to ${from} after a failed start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Its OWN catch, so a failing teardown cannot swallow the card revert
    // above — which is the half a user can be stuck on. `Run.taskId` and
    // `Task.runId` are two ends of one edge, and a chat left naming a card
    // that no longer names it back is the disagreement `run.entity.ts` says
    // nothing writes.
    if (runId !== null) {
      try {
        await this.chats.delete(runId);
      } catch (error) {
        this.logger.warn(
          `could not delete run ${runId} after a failed start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * geniro's ask on top of the user's own.
   *
   * Theirs first, on `composeSystemPrompt`'s ordering: general before
   * specific, and the report is the specific half.
   */
  private composeInstructions(own: string | undefined): string {
    const user = own?.trim() ?? '';
    return user === ''
      ? TASK_REPORT_INSTRUCTIONS
      : `${user}\n\n${TASK_REPORT_INSTRUCTIONS}`;
  }

  /**
   * Refuse a card whose agent is still working.
   *
   * The status check above cannot answer this on its own: a card dragged out
   * of `in_progress` by hand still points at the run it started, and starting
   * a second one would leave the first working in a worktree nothing names.
   *
   * It asks the RUN rather than merely noticing the id, because a settled run
   * is a card's history and not a claim on it — a task that has been through
   * review must be runnable again, and a bare `runId !== null` would refuse
   * every card that had ever run once.
   */
  /**
   * The cap and the breaker, enforced where the run is actually made.
   *
   * `GET /v1/projects/:id/queue` already narrows its handout to the free
   * slots, and that is a convenience rather than the guard: it answers a
   * conductor that asked, and nothing obliges a conductor to ask. This is the
   * line — the daemon refusing, over the rows, inside the per-project gate, so
   * two windows that polled in the same instant cannot both get past it.
   *
   * Only an autopilot start is bounded. A person pressing Run has decided to
   * spend the disk, and the breaker exists to stop UNATTENDED work — refusing
   * them is how they would be prevented from checking that the thing which
   * broke is fixed before they re-arm.
   */
  private async assertAutopilotMayStart(
    project: Project,
    input: StartTaskRun,
  ): Promise<void> {
    if ((input.startedBy ?? 'user') !== 'autopilot') {
      return;
    }
    const queue = await this.queue.read(project.id);
    if (queue.breakerOpen) {
      throw new ConflictException(
        'AUTOPILOT_BREAKER_OPEN',
        `project ${project.id} has ${queue.failureStreak} failed runs in a row — re-arm it before the autopilot starts another`,
      );
    }
    if (queue.running >= queue.cap) {
      throw new ConflictException(
        'AUTOPILOT_AT_CAP',
        `project ${project.id} is already running ${queue.running} of ${queue.cap} tasks`,
      );
    }
  }

  private async assertNotAlreadyRunning(
    task: Task,
    em: EntityManager,
  ): Promise<void> {
    if (task.runId === null) {
      return;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (run && !isTerminalRunStatus(run.status)) {
      throw new ConflictException(
        'TASK_ALREADY_RUNNING',
        `task ${task.id} is already being worked by run ${task.runId}`,
      );
    }
  }

  private async require(taskId: string, em: EntityManager): Promise<Task> {
    const task = await this.taskDao.getById(taskId, em);
    if (!task) {
      throw new NotFoundException(
        'TASK_NOT_FOUND',
        `no task with id ${taskId}`,
      );
    }
    return task;
  }

  private async requireProject(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
    return project;
  }
}
