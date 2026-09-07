import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { resolveValidDirectory } from '../../agents/utils/resolve-directory';
import { ProjectDao } from '../../projects/dao/project.dao';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type {
  TaskChangeReason,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TaskStatusMove,
  TaskWire,
} from '../tasks.types';
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
  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly events: TaskEventBus,
  ) {}

  async listForProject(projectId: string): Promise<TaskWire[]> {
    const em = this.em.fork();
    await this.requireProject(projectId, em);
    return (await this.taskDao.listForProject(projectId, em)).map(toWire);
  }

  async get(taskId: string): Promise<TaskWire> {
    const em = this.em.fork();
    return toWire(await this.require(taskId, em));
  }

  async create(input: {
    projectId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    labels?: string[];
    priority?: TaskPriority;
    dueDate?: string;
    source?: TaskSource;
    sourceRef?: string;
  }): Promise<TaskWire> {
    const em = this.em.fork();
    await this.requireProject(input.projectId, em);
    const held = await this.taskDao.countInProject(input.projectId, em);
    if (held >= MAX_TASKS_PER_PROJECT) {
      throw new BadRequestException(
        'TOO_MANY_TASKS',
        `a project holds at most ${MAX_TASKS_PER_PROJECT} tasks`,
      );
    }
    const status = input.status ?? 'backlog';
    const created = await this.taskDao.create(
      {
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? null,
        status,
        labels: JSON.stringify(input.labels ?? []),
        priority: input.priority ?? 'none',
        dueDate: input.dueDate ?? null,
        source: input.source ?? 'geniro',
        sourceRef: input.sourceRef ?? null,
        // Appended to the end of its column, never inserted: a new card is the
        // user's newest thought and moving it is one drag away.
        position: await this.taskDao.nextPositionIn(
          input.projectId,
          status,
          em,
        ),
      },
      em,
    );
    this.events.publishTaskChanged({
      taskId: created.id,
      projectId: created.projectId,
      status: created.status,
    });
    return toWire(created);
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
    return toWire(task);
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
      return toWire(task);
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
    return toWire(task);
  }

  async remove(taskId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    await this.taskDao.deleteById(taskId, em);
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
  ): Promise<void> {
    if (!(await this.projectDao.getById(projectId, em))) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
  }
}

function toWire(task: Task): TaskWire {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    labels: parseLabels(task.labels),
    source: task.source,
    sourceRef: task.sourceRef,
    branch: task.branch,
    worktreePath: task.worktreePath,
    runId: task.runId,
    reportItemId: task.reportItemId,
    position: task.position,
    priority: task.priority,
    dueDate: task.dueDate,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * Labels are stored as a JSON array in a text column, like `Item.payload`.
 * A row whose text is unreadable renders as no labels rather than failing the
 * whole board: the column is a display detail, and one corrupt row must not
 * make the project unopenable.
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
