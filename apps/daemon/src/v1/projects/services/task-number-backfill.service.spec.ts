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

import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import { TaskNumberBackfillService } from './task-number-backfill.service';

/**
 * The one-time sweep that gives boards a key and their existing cards numbers.
 *
 * Real database, because what is under test is the ORDER numbers are handed
 * out in and the counter left behind — neither of which a faked DAO could
 * report.
 */
describe('TaskNumberBackfillService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let dir: string;
  let markerPath: string;

  const service = (): TaskNumberBackfillService =>
    new TaskNumberBackfillService(projectDao, taskDao, em, markerPath);

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
    dir = mkdtempSync(join(tmpdir(), 'geniro-backfill-'));
    markerPath = join(dir, 'task-numbers-backfilled');
    em = orm.em.fork();
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
  });

  async function board(name: string): Promise<Project> {
    const project = await projectDao.create({ name, folder: '/tmp/x' });
    await em.flush();
    return project;
  }

  /**
   * Read a row back through a CLEAN identity map.
   *
   * The service forks its own `EntityManager`, so its writes land in the
   * database while this spec's `em` still holds the entities it loaded before
   * the sweep — asserting on those reads the pre-backfill values and passes
   * for the wrong reason in both directions.
   */
  async function reread(): Promise<{ projects: ProjectDao; tasks: TaskDao }> {
    em.clear();
    return { projects: projectDao, tasks: taskDao };
  }

  async function card(
    projectId: string,
    title: string,
    createdAt: Date,
  ): Promise<Task> {
    const task = await taskDao.create({ projectId, title });
    task.createdAt = createdAt;
    await em.flush();
    return task;
  }

  it('gives a board with no key one derived from its name', async () => {
    const project = await board('Simpler Case Management');

    await service().backfill();

    const { projects } = await reread();
    expect((await projects.getById(project.id, em))?.taskKey).toBe('SCM');
  });

  it('numbers existing cards OLDEST first', async () => {
    // So the identifiers read the way they would have if numbering had always
    // existed — the newest card must not become GEN-1.
    const project = await board('Geniro');
    const newer = await card(project.id, 'newer', new Date('2026-02-01'));
    const older = await card(project.id, 'older', new Date('2026-01-01'));

    await service().backfill();

    const { tasks } = await reread();
    expect((await tasks.getById(older.id, em))?.number).toBe(1);
    expect((await tasks.getById(newer.id, em))?.number).toBe(2);
  });

  it('leaves the counter where the next card will not collide', async () => {
    const project = await board('Geniro');
    await card(project.id, 'a', new Date('2026-01-01'));
    await card(project.id, 'b', new Date('2026-01-02'));

    await service().backfill();

    const { projects } = await reread();
    expect((await projects.getById(project.id, em))?.taskCounter).toBe(2);
  });

  it('numbers each board on its own, both starting at 1', async () => {
    const mine = await board('Geniro');
    const other = await board('Other');
    const a = await card(mine.id, 'a', new Date('2026-01-01'));
    const b = await card(other.id, 'b', new Date('2026-01-02'));

    await service().backfill();

    const { tasks } = await reread();
    expect((await tasks.getById(a.id, em))?.number).toBe(1);
    expect((await tasks.getById(b.id, em))?.number).toBe(1);
  });

  it('leaves a card that already has a number alone', async () => {
    const project = await board('Geniro');
    const numbered = await card(project.id, 'a', new Date('2026-01-01'));
    numbered.number = 7;
    project.taskCounter = 7;
    await em.flush();
    const fresh = await card(project.id, 'b', new Date('2026-01-02'));

    await service().backfill();

    const { tasks } = await reread();
    expect((await tasks.getById(numbered.id, em))?.number).toBe(7);
    expect((await tasks.getById(fresh.id, em))?.number).toBe(8);
  });

  it('runs ONCE, ever', async () => {
    // It WRITES, so a re-run against a board whose key a user later edits
    // would silently put the derived one back.
    writeFileSync(markerPath, 'done\n', 'utf8');
    const project = await board('Geniro');
    await card(project.id, 'a', new Date('2026-01-01'));

    expect(await service().backfill()).toBeNull();
    const { projects } = await reread();
    expect((await projects.getById(project.id, em))?.taskKey).toBeNull();
  });

  it('retires itself even when there was nothing to do', async () => {
    // A fresh install must not re-scan the board for the life of the app.
    expect(await service().backfill()).toBe(0);
    expect(await service().backfill()).toBeNull();
  });
});
