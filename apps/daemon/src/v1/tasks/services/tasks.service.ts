import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { ChatApprovalMode, RunPullRequest } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { resolveValidDirectory } from '../../agents/utils/resolve-directory';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { AgentKind } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import {
  type TaskChangeReason,
  type TaskPriority,
  type TaskSource,
  type TaskStatus,
  type TaskStatusMove,
  type TaskWire,
} from '../tasks.types';
import { parseTaskFiles } from '../utils/task-files';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';

/** How many tasks one project's board may hold — a guard, not a design limit. */
const MAX_TASKS_PER_PROJECT = 1000;

/**
 * Tasks: the cards on a project's board.
 *
 * Every task names a project, so this module depends on `ProjectsModule` and
 * that module does not depend back — see `ProjectsModule`'s own note on why
 * the DAO it needs is provided rather than imported.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly runDao: RunDao,
    private readonly events: TaskEventBus,
    private readonly attachments: TaskAttachmentService,
  ) {}

  async listForProject(projectId: string): Promise<TaskWire[]> {
    const em = this.em.fork();
    await this.requireProject(projectId, em);
    const tasks = await this.taskDao.listForProject(projectId, em);
    // ONE query for the whole board rather than one per card — the per-card
    // read below is for the paths that hold a single task.
    const byRun = await this.runDao.pullRequestsOf(
      tasks
        .map((task) => task.runId)
        .filter((runId): runId is string => runId !== null),
      em,
    );
    return tasks.map((task) =>
      toWire(task, task.runId === null ? [] : (byRun.get(task.runId) ?? [])),
    );
  }

  async get(taskId: string): Promise<TaskWire> {
    const em = this.em.fork();
    return this.wireOf(await this.require(taskId, em), em);
  }

  /**
   * One card as the wire has it, its run's pull requests included.
   *
   * Every single-task path goes through here rather than through {@link toWire}
   * directly, and that is what keeps the field honest on the paths that are NOT
   * the listing: a rename answers with the card the client then writes into its
   * board state, so a `toWire` that could not reach the run would have a saved
   * title silently take the card's pull requests off screen until the next
   * refetch.
   *
   * A card with no run costs no query at all.
   */
  private async wireOf(task: Task, em: EntityManager): Promise<TaskWire> {
    if (task.runId === null) {
      return toWire(task, []);
    }
    const byRun = await this.runDao.pullRequestsOf([task.runId], em);
    return toWire(task, byRun.get(task.runId) ?? []);
  }

  async create(input: {
    projectId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    labels?: string[];
    priority?: TaskPriority;
    dueDate?: string;
    /** Absent = run in the project's folder. See {@link Task.folder}. */
    folder?: string;
    /**
     * The run configuration for this card. Absent throughout = inherit the
     * project's, on `folder`'s own rule.
     */
    agentKind?: AgentKind;
    model?: string;
    effort?: string;
    approval?: ChatApprovalMode;
    configDir?: string;
    workflowSlug?: string;
    source?: TaskSource;
    sourceRef?: string;
  }): Promise<TaskWire> {
    const em = this.em.fork();
    const held = await this.taskDao.countInProject(input.projectId, em);
    if (held >= MAX_TASKS_PER_PROJECT) {
      throw new BadRequestException(
        'TOO_MANY_TASKS',
        `a project holds at most ${MAX_TASKS_PER_PROJECT} tasks`,
      );
    }
    const status = input.status ?? 'backlog';
    // ONE transaction around the counter and the insert, because both are
    // read-modify-writes over a value that must not repeat. The bump is
    // separated from the row it numbers by an await (`nextPositionIn`), and
    // each request runs on its own fork, so without this two creates read the
    // same counter and write the same absolute value — two cards holding one
    // user-visible number, which is exactly what taking the number from the
    // counter rather than from `max(number)` exists to prevent. `position` is
    // inside for the same reason: it is `max + 1` over the same column.
    const created = await em.transactional(async (tx) => {
      // The card's number, from the PROJECT's own counter — never from
      // `max(number)`, which would reuse the number of a deleted card and let
      // two commits name different work by one identifier.
      const project = await this.requireProject(input.projectId, tx);
      project.taskCounter += 1;
      const number = project.taskCounter;
      return this.taskDao.create(
        {
          projectId: input.projectId,
          title: input.title,
          number,
          description: input.description ?? null,
          status,
          labels: JSON.stringify(input.labels ?? []),
          priority: input.priority ?? 'none',
          dueDate: input.dueDate ?? null,
          folder:
            input.folder === undefined ? null : resolveTaskFolder(input.folder),
          agentKind: input.agentKind ?? null,
          model: input.model ?? null,
          effort: input.effort ?? null,
          approval: input.approval ?? null,
          // Checked to exist for `Project.configDir`'s reason: a card pointing
          // at a profile that is not there starts a brand-new signed-out one,
          // since the CLI creates whatever directory it is handed.
          configDir:
            input.configDir === undefined
              ? null
              : resolveTaskConfigDir(input.configDir),
          workflowSlug: input.workflowSlug ?? null,
          source: input.source ?? 'geniro',
          sourceRef: input.sourceRef ?? null,
          // Appended to the end of its column, never inserted: a new card is
          // the user's newest thought and moving it is one drag away.
          position: await this.taskDao.nextPositionIn(
            input.projectId,
            status,
            tx,
          ),
        },
        tx,
      );
    });
    this.events.publishTaskChanged({
      taskId: created.id,
      projectId: created.projectId,
      status: created.status,
    });
    return this.wireOf(created, em);
  }

  /**
   * Change a task's own fields. Deliberately NOT its status — that goes
   * through {@link moveStatus}, which is conditional.
   */
  async update(
    taskId: string,
    patch: {
      title?: string;
      description?: string | null;
      labels?: string[];
      priority?: TaskPriority;
      dueDate?: string | null;
      folder?: string | null;
      agentKind?: AgentKind | null;
      model?: string | null;
      effort?: string | null;
      approval?: ChatApprovalMode | null;
      configDir?: string | null;
      workflowSlug?: string | null;
      branch?: string | null;
      worktreePath?: string | null;
      runId?: string | null;
      reportItemId?: string | null;
    },
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);

    if (patch.title !== undefined) {
      task.title = patch.title;
    }
    if (patch.description !== undefined) {
      task.description = patch.description;
    }
    if (patch.priority !== undefined) {
      task.priority = patch.priority;
    }
    if (patch.dueDate !== undefined) {
      // `null` CLEARS the date, which is why this reads `!== undefined` rather
      // than a truthiness check: a task whose due date is dropped has to lose
      // it, while the field being absent from the patch means leave it alone.
      task.dueDate = patch.dueDate;
    }
    if (patch.labels !== undefined) {
      task.labels = JSON.stringify(patch.labels);
    }
    if (patch.folder !== undefined) {
      // `null` hands the card back to the project's folder; a path is checked
      // and canonicalized here, at the seam furthest from the worktree it will
      // be cut from — the same rule `worktreePath` below states in full.
      task.folder =
        patch.folder === null ? null : resolveTaskFolder(patch.folder);
    }
    // The run configuration, each on `folder`'s contract above: `null` hands
    // the field back to the project's default, absent leaves it alone.
    if (patch.agentKind !== undefined) {
      task.agentKind = patch.agentKind;
    }
    if (patch.model !== undefined) {
      task.model = patch.model;
    }
    if (patch.effort !== undefined) {
      task.effort = patch.effort;
    }
    if (patch.approval !== undefined) {
      task.approval = patch.approval;
    }
    if (patch.configDir !== undefined) {
      task.configDir =
        patch.configDir === null ? null : resolveTaskConfigDir(patch.configDir);
    }
    if (patch.workflowSlug !== undefined) {
      task.workflowSlug = patch.workflowSlug;
    }
    if (patch.branch !== undefined) {
      task.branch = patch.branch;
    }
    if (patch.worktreePath !== undefined) {
      // Canonicalized on the way in, like every other caller-supplied path the
      // daemon stores — this one becomes an agent's spawn cwd, and a check at
      // the consumer would sit at the seam furthest from the input.
      //
      // It therefore has to EXIST when it is recorded, which orders the
      // milestone-3 flow rather than constraining it: the worktree is created
      // and then written down. Recording a path before creating it is the one
      // thing this refuses.
      task.worktreePath =
        patch.worktreePath === null
          ? null
          : resolveValidDirectory(patch.worktreePath, {
              errorCode: 'INVALID_WORKTREE_PATH',
              noun: 'worktree path',
            });
    }
    if (patch.runId !== undefined) {
      task.runId = patch.runId;
    }
    if (patch.reportItemId !== undefined) {
      task.reportItemId = patch.reportItemId;
    }

    await em.flush();
    this.events.publishTaskChanged({
      taskId: task.id,
      projectId: task.projectId,
      status: task.status,
    });
    return this.wireOf(task, em);
  }

  /**
   * Move a task between columns, conditionally.
   *
   * `move.from` is the status the caller believed the task was in when it
   * decided to move it. If the row says otherwise, someone else moved it
   * first and this caller's move is computed against a card that no longer
   * exists as it was drawn — so it is refused rather than applied. That is the
   * whole mechanism keeping two open boards from double-starting one task:
   * both send `from: 'todo'`, and only the first one finds it there.
   *
   * The line is held by the database, in `TaskDao.compareAndSetStatus`, not by
   * the read below. The read exists to tell a caller that lost WHICH status it
   * lost to, and to answer a 404; it cannot be the guard, because computing the
   * destination position is an `await` and two callers can both pass a
   * JavaScript comparison made before it.
   *
   * A move to the status the task is already in is a no-op that succeeds:
   * re-sending it is not a conflict, and failing it would make a retried
   * request look like a lost race.
   */
  async moveStatus(
    taskId: string,
    move: TaskStatusMove,
    reason?: TaskChangeReason,
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);

    if (task.status !== move.from) {
      throw new BadRequestException(
        'TASK_STATUS_CONFLICT',
        `task ${taskId} is in ${task.status}, not ${move.from} — it moved since you last read it`,
      );
    }
    if (move.from === move.to) {
      return this.wireOf(task, em);
    }

    const position = await this.taskDao.nextPositionIn(
      task.projectId,
      move.to,
      em,
    );
    const at = new Date();
    const moved = await this.taskDao.compareAndSetStatus(
      taskId,
      move.from,
      move.to,
      position,
      at,
      em,
    );
    if (!moved) {
      throw new BadRequestException(
        'TASK_STATUS_CONFLICT',
        `task ${taskId} moved out of ${move.from} while this move was being applied`,
      );
    }

    // Carried onto the entity by hand: the conditional UPDATE went around the
    // UnitOfWork, so the row the caller is about to be handed back is only
    // correct if these three follow it. Nothing flushes this fork afterwards.
    task.status = move.to;
    task.position = position;
    task.updatedAt = at;
    this.events.publishTaskChanged({
      taskId: task.id,
      projectId: task.projectId,
      status: task.status,
      reason,
    });
    return this.wireOf(task, em);
  }

  async remove(taskId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    await this.taskDao.deleteById(taskId, em);
    // The pasted images go with the card. Nothing else can reach them once the
    // row is gone — there is no surface in the app that lists a deleted card's
    // files — so a screenshot of a console or a private repository would sit on
    // disk for good. After the row, and not inside a transaction with it: the
    // delete is what the caller asked for, and a filesystem error must not
    // report a card that IS deleted as still standing, nor swallow the
    // broadcast the board redraws from.
    try {
      await this.attachments.removeTask(taskId);
    } catch (error) {
      this.logger.warn(
        `could not drop attachments for task ${taskId}: ${String(error)}`,
      );
    }
    // Captured off the row BEFORE the delete rather than re-read after: a
    // soft-deleted task is invisible to `getById` (the `softDelete` filter),
    // so there is nothing left here to read `status`/`projectId` off of.
    this.events.publishTaskChanged({
      taskId: task.id,
      projectId: task.projectId,
      status: task.status,
    });
    return { deleted: true };
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

  /**
   * A task must name a project that exists. Without this a create would
   * succeed into a board nobody can open — invisible to every per-project
   * read, and still matching the autopilot's cross-project intake query.
   */
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
    // Returned MANAGED, so a caller that bumps `taskCounter` has its change
    // written by the same `em.flush()` that inserts the card — one unit of
    // work, so a card can never exist holding a number the counter forgot.
    return project;
  }
}

function toWire(
  task: Task,
  /**
   * What its run opened, which the task row does not hold and cannot answer
   * for itself — see {@link TaskWireSchema.shape.pullRequests}. Passed in
   * rather than read here so the board's listing can answer for every card in
   * one query.
   */
  pullRequests: readonly RunPullRequest[],
): TaskWire {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    number: task.number,
    description: task.description,
    attachments: parseTaskFiles(task.attachments),
    status: task.status,
    labels: parseLabels(task.labels),
    source: task.source,
    sourceRef: task.sourceRef,
    folder: task.folder,
    agentKind: task.agentKind,
    model: task.model,
    effort: task.effort,
    approval: task.approval,
    configDir: task.configDir,
    workflowSlug: task.workflowSlug,
    branch: task.branch,
    worktreePath: task.worktreePath,
    runId: task.runId,
    reportItemId: task.reportItemId,
    pullRequests: [...pullRequests],
    position: task.position,
    priority: task.priority,
    dueDate: task.dueDate,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * A card's own folder, canonicalized and checked to exist.
 *
 * Its own helper because BOTH writes need it and they are far apart in this
 * file — a create that resolved and an update that did not would let a card be
 * edited into a folder no worktree can be cut from, which is exactly the state
 * the check exists to prevent.
 */
function resolveTaskFolder(folder: string): string {
  return resolveValidDirectory(folder, {
    errorCode: 'INVALID_TASK_FOLDER',
    noun: 'task folder',
  });
}

/**
 * A card's own agent config directory, canonicalized and checked to exist.
 *
 * Its own helper for `resolveTaskFolder`'s reason — both writes need it — and
 * checked at all for `Project.configDir`'s: the CLI CREATES whatever directory
 * it is handed and then ends the turn "Not logged in", so a typo here starts a
 * brand-new signed-out profile instead of failing.
 */
function resolveTaskConfigDir(configDir: string): string {
  return resolveValidDirectory(configDir, {
    errorCode: 'INVALID_CONFIG_DIR',
    noun: 'config directory',
  });
}

/**
 * The card's labels, tolerating a column written by an older build or by a
 * hand that edited the database — a corrupt row renders as NO labels rather
 * than failing the whole board.
 */
function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((label): label is string => typeof label === 'string');
  } catch {
    return [];
  }
}
