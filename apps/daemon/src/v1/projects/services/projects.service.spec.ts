import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import { ProjectsService } from './projects.service';

/**
 * Real database, real DAOs: the behaviour under test is that deleting a
 * project takes its tasks with it, and nothing in this daemon cascades — so
 * the removal is the service's own two calls, and the soft-delete filter is
 * what makes the tasks unreadable afterwards. A faked DAO would let the
 * service's arrangement pass while proving nothing about either.
 */
describe('ProjectsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: ProjectsService;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let folder: string;
  let otherFolder: string;

  beforeAll(async () => {
    // A real directory, because `create` canonicalizes the folder through
    // `resolveValidDirectory` and refuses one that does not exist.
    folder = mkdtempSync(join(tmpdir(), 'geniro-project-'));
    otherFolder = mkdtempSync(join(tmpdir(), 'geniro-project-'));
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
    rmSync(folder, { recursive: true, force: true });
    rmSync(otherFolder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    service = new ProjectsService(em, projectDao, taskDao);
  });

  it('removes a project’s tasks along with the project', async () => {
    const project = await service.create({ name: 'Board', folder });
    await taskDao.create({ projectId: project.id, title: 'first' });
    await taskDao.create({ projectId: project.id, title: 'second' });

    const result = await service.remove(project.id);

    expect(result).toEqual({ deleted: true, tasksRemoved: 2 });
    // The real observable: a read after the delete returns nothing. The rows
    // are soft-deleted, so this is the `softDelete` filter hiding them — which
    // is exactly what every other reader of this table will see.
    expect(await taskDao.listForProject(project.id)).toEqual([]);
    expect(await projectDao.getById(project.id)).toBeNull();
  });

  it('leaves another project’s tasks alone when one is deleted', async () => {
    const doomed = await service.create({ name: 'Doomed', folder });
    const kept = await service.create({ name: 'Kept', folder: otherFolder });
    await taskDao.create({ projectId: doomed.id, title: 'goes' });
    const survivor = await taskDao.create({
      projectId: kept.id,
      title: 'stays',
    });

    await service.remove(doomed.id);

    const remaining = await taskDao.listForProject(kept.id);
    expect(remaining.map((task) => task.id)).toEqual([survivor.id]);
  });

  it('refuses to delete a project that does not exist', async () => {
    await expect(service.remove('no-such-project')).rejects.toMatchObject({
      // The guard exists so a delete cannot silently report success for a id
      // that names nothing — a board the caller thinks it removed.
      message: expect.stringContaining('no-such-project'),
    });
  });

  it('refuses a folder that is not a directory on disk', async () => {
    await expect(
      service.create({ name: 'Bad', folder: join(folder, 'does-not-exist') }),
    ).rejects.toMatchObject({ message: expect.stringContaining('does not exist') });
  });

  it('clears a nullable field on an explicit null and leaves omitted keys alone', async () => {
    const project = await service.create({
      name: 'Board',
      folder,
      model: 'sonnet',
      workflowSlug: 'ship-it',
    });

    const updated = await service.update(project.id, { model: null });

    expect(updated.model).toBeNull();
    // The omitted key is the half that is easy to break: a patch that rebuilds
    // the row from its own fields would blank this too.
    expect(updated.workflowSlug).toBe('ship-it');
  });
});
