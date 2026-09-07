import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../projects.types';
import { ProjectQueueService } from './project-queue.service';

/**
 * Real database, real DAOs. What is under test is a count taken over rows —
 * how many of a project's cards hold a run that is still live — so faking the
 * DAOs would assert the arrangement and prove nothing about the answer.
 */
describe('ProjectQueueService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: ProjectQueueService;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let folder: string;
  let projectId: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-queue-'));
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task, Run],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    runDao = new RunDao(em);
    service = new ProjectQueueService(em, projectDao, taskDao, runDao);

    const project = await projectDao.create({
      name: 'board',
      folder,
      autopilotEnabled: true,
      autopilotIntakeStatus: 'todo',
      autopilotMaxConcurrent: 2,
    });
    await em.flush();
    projectId = project.id;
  });

  async function addTask(
    title: string,
    status: Task['status'],
    position: number,
    runId: string | null = null,
  ): Promise<Task> {
    const task = await taskDao.create({
      projectId,
      title,
      status,
      position,
      runId,
    });
    await em.flush();
    return task;
  }

  async function addRun(status: Run['status']): Promise<Run> {
    const run = await runDao.create({ status });
    await em.flush();
    return run;
  }

  async function arm(patch: Partial<Project>): Promise<void> {
    const project = await projectDao.getById(projectId, em);
    Object.assign(project as Project, patch);
    await em.flush();
  }

  it('hands out the intake column, oldest first, when nothing is running', async () => {
    await addTask('second', 'todo', 1);
    await addTask('first', 'todo', 0);
    await addTask('not intake', 'backlog', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual([
      'first',
      'second',
    ]);
    expect(queue.waiting).toBe(2);
    expect(queue.running).toBe(0);
    expect(queue.cap).toBe(2);
  });

  // The handout is what the conductor cuts a worktree from, and it runs in
  // another process with only this reply in hand — so the inheritance is
  // resolved HERE. A card that names no folder takes the project's; one that
  // names its own keeps it, which is the whole point of the column.
  it('hands out the folder each CARD names, else the project one', async () => {
    const own = mkdtempSync(join(tmpdir(), 'geniro-card-'));
    try {
      const inherits = await addTask('inherits', 'todo', 0);
      const names = await addTask('names its own', 'todo', 1);
      names.folder = own;
      await em.flush();

      const queue = await service.read(projectId);

      expect(
        Object.fromEntries(
          queue.eligible.map((task) => [task.id, task.folder]),
        ),
      ).toEqual({ [inherits.id]: folder, [names.id]: own });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('narrows the handout to the free slots', async () => {
    const run = await addRun('running');
    await addTask('working', 'in_progress', 0, run.id);
    await addTask('a', 'todo', 1);
    await addTask('b', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(1);
    // Two waiting, a cap of two, one slot taken — so one goes out, not two.
    expect(queue.waiting).toBe(2);
    expect(queue.eligible.map((task) => task.title)).toEqual(['a']);
  });

  // The reason the count asks the RUNS and not the `in_progress` column: a card
  // dragged back to `todo` by hand still points at the agent working it, and a
  // count that believed the column would hand out a slot that is not free.
  it('counts a live run whose card was dragged out of in_progress', async () => {
    const run = await addRun('running');
    await addTask('dragged back', 'todo', 0, run.id);
    await addTask('waiting', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(1);
  });

  it('does not count a settled run — a card that has been through review runs again', async () => {
    const run = await addRun('completed');
    await addTask('reviewed', 'in_review', 0, run.id);
    await addTask('next', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(0);
    expect(queue.eligible).toHaveLength(1);
  });

  it('hands out nothing while the project is disarmed, and still reports the column', async () => {
    await arm({ autopilotEnabled: false });
    await addTask('a', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.enabled).toBe(false);
    expect(queue.eligible).toEqual([]);
    expect(queue.waiting).toBe(1);
  });

  it('hands out nothing while the breaker is open', async () => {
    await arm({ autopilotFailureStreak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    await addTask('a', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.breakerOpen).toBe(true);
    expect(queue.eligible).toEqual([]);
  });

  it('keeps the breaker shut one failure short of the threshold', async () => {
    await arm({
      autopilotFailureStreak: PROJECT_FAILURE_BREAKER_THRESHOLD - 1,
    });
    await addTask('a', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.breakerOpen).toBe(false);
    expect(queue.eligible).toHaveLength(1);
  });

  it('hands out nothing when every slot is taken', async () => {
    const first = await addRun('running');
    const second = await addRun('pending');
    await addTask('one', 'in_progress', 0, first.id);
    await addTask('two', 'in_progress', 1, second.id);
    await addTask('queued', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(2);
    expect(queue.eligible).toEqual([]);
  });

  it('reads the intake column the project names, not a hardcoded one', async () => {
    await arm({ autopilotIntakeStatus: 'backlog' });
    await addTask('in backlog', 'backlog', 0);
    await addTask('in todo', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.intakeStatus).toBe('backlog');
    expect(queue.eligible.map((task) => task.title)).toEqual(['in backlog']);
  });

  it('refuses a project that does not exist', async () => {
    await expect(service.read('nope')).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });
});
