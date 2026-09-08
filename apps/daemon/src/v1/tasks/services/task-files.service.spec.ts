import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { TASK_FILES_MAX } from '../tasks.types';
import { TaskEventBus } from './task-events.bus';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/**
 * The files a user binds to a card.
 *
 * REPORTED as the missing half — "я всё ещё не могу прицеплять файлы, например
 * zip-архивы, то есть как attachments". Real database and a real directory,
 * because what is under test is a path that has to EXIST and a column that has
 * to round-trip.
 */
describe('TaskFilesService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: TaskFilesService;
  let tasks: TasksService;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task],
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
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dir = mkdtempSync(join(tmpdir(), 'geniro-files-'));
    em = orm.em.fork();
    const taskDao = new TaskDao(em);
    const projectDao = new ProjectDao(em);
    tasks = new TasksService(em, taskDao, projectDao, new TaskEventBus());
    service = new TaskFilesService(em, taskDao, tasks);
    const project = await projectDao.create({ name: 'B', folder: dir });
    await em.flush();
    const task = await tasks.create({ projectId: project.id, title: 'card' });
    taskId = task.id;
  });

  const write = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, 'x');
    return path;
  };

  it('binds a file by PATH and states its size', async () => {
    const path = write('bundle.zip');

    const task = await service.attach(taskId, path);

    expect(task.attachments).toEqual([
      { id: expect.any(String), name: 'bundle.zip', path, bytes: 1 },
    ]);
  });

  it('refuses a path with no file behind it', async () => {
    // Checked HERE for the reason every other user-supplied path in this
    // daemon is: a card naming a file nobody can open would be discovered by
    // the agent, minutes later, one process away.
    await expect(
      service.attach(taskId, join(dir, 'not-there.zip')),
    ).rejects.toThrow(/no file at/);
  });

  it('refuses a DIRECTORY', async () => {
    await expect(service.attach(taskId, dir)).rejects.toThrow(/not a file/);
  });

  it('refuses a relative path', async () => {
    await expect(service.attach(taskId, 'bundle.zip')).rejects.toThrow(
      /absolute/,
    );
  });

  it('treats attaching the same file twice as the double-press it is', async () => {
    const path = write('bundle.zip');

    await service.attach(taskId, path);
    const task = await service.attach(taskId, path);

    expect(task.attachments).toHaveLength(1);
  });

  it('bounds the list, since it is read into the agent’s prompt', async () => {
    for (let i = 0; i < TASK_FILES_MAX; i += 1) {
      await service.attach(taskId, write(`f${i}.txt`));
    }

    await expect(service.attach(taskId, write('one-more.txt'))).rejects.toThrow(
      /at most/,
    );
  });

  it('detaches the reference and LEAVES THE FILE', async () => {
    // geniro did not put it there. A detach that deleted a user's own archive
    // would be unforgivable, and it is the one thing this service must never
    // do.
    const path = write('bundle.zip');
    const attached = await service.attach(taskId, path);

    const task = await service.detach(taskId, attached.attachments[0]!.id);

    expect(task.attachments).toEqual([]);
    expect(() => writeFileSync(path, 'still here')).not.toThrow();
  });

  it('answers with the card when the id names nothing', async () => {
    // A double-press on remove, or a stale panel. Nothing to do is not an
    // error, and the caller redraws from the answer either way.
    const task = await service.detach(taskId, 'no-such-id');

    expect(task.attachments).toEqual([]);
  });
});
