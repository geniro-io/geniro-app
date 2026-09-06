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
import { TasksService } from './tasks.service';

/**
 * Real database, real DAOs. The behaviour under test is a compare-and-set
 * against the stored status, so the stored status has to be real: a faked DAO
 * would return whatever the test told it to and the conflict branch would
 * never be entered.
 */
describe('TasksService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let projectId: string;
  // The fork the DAOs and the service share. A test that writes a row directly
  // must flush on THIS one: `orm.em` is a different UnitOfWork and does not
  // manage entities loaded here, so a write flushed there never lands.
  let em: EntityManager;

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
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    service = new TasksService(em, taskDao, projectDao);
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-tasks-spec',
    });
    projectId = project.id;
  });

  it('moves a task to the next column when the caller’s `from` still matches', async () => {
    const task = await service.create({ projectId, title: 'ship it' });

    const moved = await service.moveStatus(task.id, {
      from: 'backlog',
      to: 'todo',
    });

    expect(moved.status).toBe('todo');
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
  });

  it('refuses a move whose `from` is stale — the second of two boards loses', async () => {
    const task = await service.create({ projectId, title: 'run me' });
    // The first board wins the race and the card is now in `in_progress`.
    await service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });

    // The second board is still drawing the card in `backlog` and drags it.
    await expect(
      service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('it moved since you last read it'),
    });

    // And the losing move changed nothing — the point of refusing it.
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('accepts a move to the status the task is already in, as a no-op', async () => {
    const task = await service.create({ projectId, title: 'idempotent' });

    const moved = await service.moveStatus(task.id, {
      from: 'backlog',
      to: 'backlog',
    });

    // A retried request must not read as a lost race.
    expect(moved.status).toBe('backlog');
    // And the early return is what this observes: without it the move falls
    // through to the position allocation and the card is appended past itself,
    // so the status alone would pass on both sides of the branch.
    expect(moved.position).toBe(0);
    expect((await taskDao.getById(task.id))?.position).toBe(0);
  });

  it('appends each new task to the end of its column', async () => {
    const first = await service.create({ projectId, title: 'first' });
    const second = await service.create({ projectId, title: 'second' });

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
  });

  it('places a moved task at the end of the column it lands in', async () => {
    await service.create({
      projectId,
      title: 'already in todo',
      status: 'todo',
    });
    const mover = await service.create({ projectId, title: 'arriving' });

    const moved = await service.moveStatus(mover.id, {
      from: 'backlog',
      to: 'todo',
    });

    expect(moved.position).toBe(1);
  });

  it('gives every live card in a column a distinct position, after a delete', async () => {
    // A soft-deleted card keeps its position while leaving the live count, so
    // an allocation that counted would hand this slot out twice.
    const first = await service.create({ projectId, title: 'first' });
    const second = await service.create({ projectId, title: 'second' });
    expect([first.position, second.position]).toEqual([0, 1]);

    await service.remove(first.id);
    const third = await service.create({ projectId, title: 'third' });

    const live = await taskDao.listInStatus(projectId, 'backlog');
    const positions = live.map((task) => task.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(third.position).toBe(2);
  });

  it('gives every live card in a column a distinct position, after a move-out', async () => {
    // The other route into the same collision: a move sets only the mover's
    // own position, so its old column keeps a hole the count cannot see.
    const leaving = await service.create({ projectId, title: 'leaving' });
    const staying = await service.create({ projectId, title: 'staying' });
    await service.moveStatus(leaving.id, { from: 'backlog', to: 'todo' });

    const arriving = await service.create({ projectId, title: 'arriving' });

    const backlog = await taskDao.listInStatus(projectId, 'backlog');
    const positions = backlog.map((task) => task.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(arriving.position).not.toBe(staying.position);
  });

  it('refuses a task past the per-project cap', async () => {
    const filler = Array.from({ length: 999 }, (_, i) => ({
      projectId,
      title: `filler ${i}`,
    }));
    await taskDao.createMany(filler, em);

    // The last one the cap permits. Asserting only the refusal leaves a guard
    // that fires a row early looking correct.
    await expect(
      service.create({ projectId, title: 'the thousandth' }),
    ).resolves.toMatchObject({ title: 'the thousandth' });

    await expect(
      service.create({ projectId, title: 'one too many' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('at most'),
    });
  });

  it('refuses a task naming a project that does not exist', async () => {
    await expect(
      service.create({ projectId: 'no-such-project', title: 'orphan' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no-such-project'),
    });
    expect(await taskDao.countInProject('no-such-project')).toBe(0);
  });

  it('round-trips labels through the JSON text column', async () => {
    const task = await service.create({
      projectId,
      title: 'labelled',
      labels: ['bug', 'ui'],
    });

    expect(task.labels).toEqual(['bug', 'ui']);
    expect((await service.get(task.id)).labels).toEqual(['bug', 'ui']);
  });

  it('reads a task whose stored labels are unreadable as having none', async () => {
    // The fixture must carry labels: with none, the healthy and the corrupt
    // readings are both `[]` and nothing here observes the guard.
    const task = await service.create({
      projectId,
      title: 'corrupt',
      labels: ['bug'],
    });
    expect(task.labels).toEqual(['bug']);

    const row = await taskDao.getById(task.id);
    if (!row) {
      throw new Error('the task under test disappeared');
    }
    row.labels = 'not json at all';
    // On the fork that OWNS this row. `orm.em` is a separate UnitOfWork which
    // never loaded it, so flushing there writes nothing and the assertion
    // below would be reading the healthy row back.
    await em.flush();

    expect((await service.get(task.id)).labels).toEqual([]);
  });

  it('drops stored labels that are not strings', async () => {
    const task = await service.create({
      projectId,
      title: 'wrong shape',
      labels: ['bug'],
    });
    const row = await taskDao.getById(task.id);
    if (!row) {
      throw new Error('the task under test disappeared');
    }
    // An array holding a non-string is the one malformed shape whose handling
    // is observable: without the type filter these numbers reach
    // `TaskWire.labels`, which is typed `string[]`.
    //
    // The `!Array.isArray` arm beside it cannot be pinned at all, and that is
    // a property of the code rather than a gap here: every non-array throws
    // inside `filter` and lands in the same `catch`, so removing the check
    // returns `[]` exactly as keeping it does. It stays because reaching a
    // result through an exception is not the same as deciding it.
    row.labels = '[1,"ok",2]';
    await em.flush();

    expect((await service.get(task.id)).labels).toEqual(['ok']);
  });
});
