import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { ProjectDao } from '../../projects/dao/project.dao';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type {
  TaskSource,
  TaskStatus,
  TaskStatusMove,
  TaskWire,
} from '../tasks.types';

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
        source: input.source ?? 'geniro',
        sourceRef: input.sourceRef ?? null,
        // Appended to the end of its column, never inserted: a new card is the
        // user's newest thought and moving it is one drag away.
        position: await this.taskDao.countInStatus(
          input.projectId,
          status,
          em,
        ),
      },
      em,
    );
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
      branch?: string | null;
      worktreePath?: string | null;
      runId?: string | null;
      reportItemId?: string | null;
    },
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.labels !== undefined) task.labels = JSON.stringify(patch.labels);
    if (patch.branch !== undefined) task.branch = patch.branch;
    if (patch.worktreePath !== undefined) {
      task.worktreePath = patch.worktreePath;
    }
    if (patch.runId !== undefined) task.runId = patch.runId;
    if (patch.reportItemId !== undefined) {
      task.reportItemId = patch.reportItemId;
    }

    await em.flush();
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
   * A move to the status the task is already in is a no-op that succeeds:
   * re-sending it is not a conflict, and failing it would make a retried
   * request look like a lost race.
   */
  async moveStatus(taskId: string, move: TaskStatusMove): Promise<TaskWire> {
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

    task.status = move.to;
    task.position = await this.taskDao.countInStatus(
      task.projectId,
      move.to,
      em,
    );
    await em.flush();
    return toWire(task);
  }

  async remove(taskId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    await this.require(taskId, em);
    await this.taskDao.deleteById(taskId, em);
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
