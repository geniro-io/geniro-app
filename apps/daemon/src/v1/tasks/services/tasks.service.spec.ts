import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TasksService } from './tasks.service';

/**
 * Real database, real DAOs. The behaviour under test is a compare-and-set
 * against the stored status, so the stored status has to be real: a faked DAO
 * would return whatever the test told it to and the conflict branch would
 * never be entered.
 */
/**
 * Where this spec's attachment deletes are aimed.
 *
 * Named explicitly rather than left to the service's default, which resolves
 * `environment.userDataDir` — the one shared resource the specs redirect for
 * themselves. Nothing is written here; the service only ever removes
 * `<root>/<task uuid>`, which cannot exist for a freshly minted id.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-attachments-spec');

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
  /**
   * A real directory, in its CANONICAL form — the shape the service stores.
   *
   * `update` puts `worktreePath` through `resolveValidDirectory`, which both
   * refuses a path that is not on disk AND resolves its symlinks. On macOS
   * `os.tmpdir()` is `/var/folders/…`, itself a symlink to `/private/var/…`,
   * so a raw `mkdtempSync` result and what the service stores differ by that
   * prefix and the round-trip below fails on every Mac while passing on Linux,
   * where `/var` is a real directory. Canonicalizing the fixture at creation
   * is what `resolve-cwd.spec.ts` and `cli-auth.service.spec.ts` already do.
   */
  let worktree: string;
  let events: TaskEventBus;
  let changes: TaskChangedEvent[];

  beforeAll(async () => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-worktree-')));
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
    rmSync(worktree, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    events = new TaskEventBus();
    changes = [];
    events.allChanges().subscribe((e) => changes.push(e));
    service = new TasksService(
      em,
      taskDao,
      projectDao,
      new RunDao(em),
      events,
      new TaskAttachmentService(ATTACHMENTS_ROOT),
    );
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

  // The test above refuses a move whose `from` was already stale when it was
  // SENT, which a JavaScript comparison catches on its own. This one is the
  // case that comparison cannot catch: both moves are in flight at once, so
  // both read the card in `todo` before either writes. Only a conditional
  // UPDATE separates them — and the autopilot's sweep is exactly this caller,
  // fanning several starts out inside one tick.
  it('lets exactly one of two simultaneous identical moves win', async () => {
    const task = await service.create({ projectId, title: 'contended' });
    await service.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    changes.length = 0;

    const settled = await Promise.allSettled([
      service.moveStatus(task.id, { from: 'todo', to: 'in_progress' }),
      service.moveStatus(task.id, { from: 'todo', to: 'in_progress' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((r) => r.status === 'rejected');
    // Either refusal is correct and which one fires depends on how the two
    // interleave: the loser may still be reading when the winner's UPDATE
    // lands (the stale-`from` branch) or may reach its own UPDATE and match no
    // row. Both say the card moved; asserting one of them would pin the
    // interleaving rather than the behaviour.
    expect((loser?.reason as Error | undefined)?.message).toMatch(/moved/);
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
    // One winner means one redraw. A board told twice that the same card
    // arrived would be the same double-start seen from the client side.
    expect(changes).toHaveLength(1);
  });

  it('drops the card’s pasted images when the card is deleted', async () => {
    // Nothing else can reach them once the row is gone — there is no surface
    // in the app that lists a deleted card's files — so a screenshot of a
    // console or a private repository would sit on disk for good.
    const task = await service.create({ projectId, title: 'has a paste' });
    const dir = join(ATTACHMENTS_ROOT, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), 'bytes');

    await service.remove(task.id);

    expect(existsSync(dir)).toBe(false);
  });

  it('emits on the task bus after a create, with the fixed board payload', async () => {
    const task = await service.create({ projectId, title: 'ship it' });

    expect(changes).toEqual([
      { taskId: task.id, projectId, status: 'backlog' },
    ]);
  });

  it('emits on the task bus after a status move, naming the NEW status', async () => {
    const task = await service.create({ projectId, title: 'ship it' });
    changes.length = 0; // the create above emits too; isolate the move

    await service.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
  });

  it('does not emit on a no-op move — nothing changed for a board to redraw', async () => {
    const task = await service.create({ projectId, title: 'idempotent' });
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'backlog', to: 'backlog' });

    expect(changes).toEqual([]);
  });

  it('does not emit on a refused (stale) move', async () => {
    const task = await service.create({ projectId, title: 'run me' });
    await service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    changes.length = 0;

    await expect(
      service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' }),
    ).rejects.toThrow();

    expect(changes).toEqual([]);
  });

  it('emits on the task bus after a field update, naming its unchanged status', async () => {
    const task = await service.create({ projectId, title: 'ship it' });
    changes.length = 0;

    await service.update(task.id, { title: 'renamed' });

    expect(changes).toEqual([
      { taskId: task.id, projectId, status: 'backlog' },
    ]);
  });

  it('emits on the task bus after a delete, naming the status it held', async () => {
    const task = await service.create({
      projectId,
      title: 'to delete',
      status: 'todo',
    });
    changes.length = 0;

    await service.remove(task.id);

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
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

  it('gives two SIMULTANEOUS creates different numbers and positions', async () => {
    // The counter is bumped and read back across an await (`nextPositionIn`),
    // on a per-request fork, so without a transaction around the pair both
    // creates read the same counter and write the same absolute value — two
    // cards holding one user-visible `GEN-12`, drawn on the board and, through
    // `Run.taskIdentifier`, in the chat sidebar. Taking the number from the
    // counter rather than from `max(number)` exists to prevent exactly that.
    const [first, second] = await Promise.all([
      service.create({ projectId, title: 'first' }),
      service.create({ projectId, title: 'second' }),
    ]);

    expect(first.number).not.toBe(second.number);
    expect(new Set([first.number, second.number]).size).toBe(2);
    expect(first.position).not.toBe(second.position);
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

  it('refuses a worktree path that is not a directory on disk', async () => {
    // It becomes an agent's spawn cwd, so it is canonicalized at write time
    // like every other caller-supplied path the daemon stores.
    const task = await service.create({ projectId, title: 'needs a tree' });

    await expect(
      service.update(task.id, { worktreePath: '/no/such/worktree/anywhere' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('clears the worktree path on an explicit null', async () => {
    // The other arm of the check above: `null` releases the worktree and must
    // not be handed to `resolveValidDirectory`, which would refuse it as a
    // path that does not exist and leave a released worktree unclearable.
    const task = await service.create({ projectId, title: 'has a tree' });
    const attached = await service.update(task.id, {
      worktreePath: worktree,
    });
    expect(attached.worktreePath).toBe(worktree);

    const released = await service.update(task.id, { worktreePath: null });

    expect(released.worktreePath).toBeNull();
  });

  // A card's folder is the project's DEFAULT overridden, so null is the
  // ordinary state and means INHERIT — never "nowhere". A snapshot of the
  // project's folder taken at create would look identical here and turn the
  // project's setting into a one-time seed the moment it was changed.
  it('leaves a new task inheriting its project folder', async () => {
    const task = await service.create({ projectId, title: 'ordinary' });

    expect(task.folder).toBeNull();
  });

  it('takes a folder of its own, canonicalized like every stored path', async () => {
    const task = await service.create({
      projectId,
      title: 'elsewhere',
      folder: worktree,
    });

    expect(task.folder).toBe(worktree);
  });

  it('refuses a task folder that is not a directory on disk', async () => {
    // The same rule the worktree path follows, and for a sharper reason: this
    // one is what a worktree is CUT FROM, so an unchecked value fails minutes
    // later in another process, as a git error about a path nobody typed here.
    await expect(
      service.create({
        projectId,
        title: 'nowhere',
        folder: '/no/such/folder/anywhere',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('hands a card back to the project folder on an explicit null', async () => {
    // Inheriting AGAIN is a thing a user does to a card that already names a
    // folder, and there is no other way to say it — hence nullable on the
    // patch where create's field is merely optional.
    const task = await service.create({
      projectId,
      title: 'elsewhere',
      folder: worktree,
    });

    const back = await service.update(task.id, { folder: null });

    expect(back.folder).toBeNull();
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
  it('leaves a new task untriaged rather than guessing a priority', async () => {
    // `none` has to be distinguishable from a deliberate `low`, so the default
    // is its own value and not the bottom of the scale.
    const task = await service.create({ projectId, title: 'fresh' });

    expect(task.priority).toBe('none');
    expect(task.dueDate).toBeNull();
  });

  it('round-trips a priority and a due date through create', async () => {
    const task = await service.create({
      projectId,
      title: 'ship the board',
      priority: 'urgent',
      dueDate: '2026-09-30',
    });

    expect(task.priority).toBe('urgent');
    expect(task.dueDate).toBe('2026-09-30');
  });

  it('stores the due date as the calendar day it was given, with no zone shift', async () => {
    // The whole reason it is a string column. Round-tripping through a `Date`
    // would pin the day to whichever zone wrote it and move it for everyone
    // else — a task due the 30th must not read as the 29th somewhere.
    const task = await service.create({
      projectId,
      title: 'day, not instant',
      dueDate: '2026-01-01',
    });

    expect(task.dueDate).toBe('2026-01-01');
    expect(String(task.dueDate)).not.toContain('T');
  });

  it('clears a due date on an explicit null', async () => {
    // The other arm of `!== undefined`: dropping a date has to be possible,
    // and is different from leaving the field out of the patch.
    const task = await service.create({
      projectId,
      title: 'was due',
      dueDate: '2026-09-30',
    });

    const cleared = await service.update(task.id, { dueDate: null });

    expect(cleared.dueDate).toBeNull();
  });

  it('leaves the due date alone when the patch does not mention it', async () => {
    const task = await service.create({
      projectId,
      title: 'still due',
      dueDate: '2026-09-30',
    });

    const renamed = await service.update(task.id, { title: 'renamed' });

    expect(renamed.dueDate).toBe('2026-09-30');
  });
});

/**
 * A card's NUMBER — the `12` of `GEN-12`.
 *
 * ASKED FOR as Linear's scheme, and the property that makes an identifier worth
 * having is that it names one card for good.
 */
describe('TasksService — card numbering (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TasksService;
  let projectDao: ProjectDao;
  let projectId: string;
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
    const taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    service = new TasksService(
      em,
      taskDao,
      projectDao,
      new RunDao(em),
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
    );
    const project = await projectDao.create({
      name: 'Geniro',
      taskKey: 'GEN',
      folder: realpathSync(tmpdir()),
    });
    await em.flush();
    projectId = project.id;
  });

  it('numbers cards 1, 2, 3 as they are made', async () => {
    const first = await service.create({ projectId, title: 'one' });
    const second = await service.create({ projectId, title: 'two' });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it('never REUSES a number, even after the card holding it is deleted', async () => {
    // The reason the counter is on the project rather than `max(number)`: two
    // commits naming different work by one identifier is the failure this
    // whole feature would otherwise introduce.
    const first = await service.create({ projectId, title: 'one' });
    await service.remove(first.id);
    const second = await service.create({ projectId, title: 'two' });

    expect(second.number).toBe(2);
  });

  it('counts per BOARD, so two projects both start at 1', async () => {
    const other = await projectDao.create({
      name: 'Other',
      taskKey: 'OTH',
      folder: realpathSync(tmpdir()),
    });
    await em.flush();

    const mine = await service.create({ projectId, title: 'one' });
    const theirs = await service.create({
      projectId: other.id,
      title: 'one',
    });

    expect(mine.number).toBe(1);
    expect(theirs.number).toBe(1);
  });

  it('leaves the counter alone when the create is refused', async () => {
    // The counter is bumped on the entity and written by the SAME flush that
    // inserts the card, so a refusal further in must not consume a number —
    // otherwise a board develops gaps for cards that never existed.
    await expect(
      service.create({ projectId: 'no-such-project', title: 'x' }),
    ).rejects.toThrow();
    const first = await service.create({ projectId, title: 'one' });

    expect(first.number).toBe(1);
  });
});
