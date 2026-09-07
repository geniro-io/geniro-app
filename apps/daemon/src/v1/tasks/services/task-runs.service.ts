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

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
    private readonly chats: ChatService,
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
      return await this.startClaimed(taskId, input);
    } finally {
      this.starting.delete(taskId);
    }
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

    // The MOVE is the reservation, which is why it happens before the chat
    // exists rather than after: a card sitting in `in_progress` is what a
    // second board's start is refused against. Everything after it is undone
    // by `abandon` if the run cannot be made.
    await this.tasks.moveStatus(taskId, {
      from: input.from,
      to: 'in_progress',
    });

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

      const wire = await this.tasks.update(taskId, {
        runId: run.id,
        branch: input.branch,
        worktreePath: input.cwd,
      });

      // Last, because it is the only step whose failure leaves something worth
      // keeping: the conversation exists and the user can send to it by hand.
      await this.chats.sendMessage(run.id, composeTaskPrompt(task));
      return wire;
    } catch (error) {
      await this.abandon(taskId, input.from);
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
  private async abandon(taskId: string, from: Task['status']): Promise<void> {
    try {
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
