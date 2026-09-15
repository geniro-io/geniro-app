import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../../projects/projects.types';
import { isBreakerOpen } from '../../projects/utils/breaker';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { RunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskSettleService } from './task-settle.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout. What is under test is where a card lands when its
 * run ends by itself — a read of stored state, so faking the store would leave
 * nothing to observe.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-settle-spec');

describe('TaskSettleService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskSettleService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let itemDao: ItemDao;
  let em: EntityManager;
  let bus: AgentEventBus;
  let taskEvents: TaskEventBus;
  let changes: TaskChangedEvent[];
  let projectId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task, Run, Item],
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
    runDao = new RunDao(em);
    itemDao = new ItemDao(em);
    taskEvents = new TaskEventBus();
    changes = [];
    taskEvents.allChanges().subscribe((event) => changes.push(event));
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      taskEvents,
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      runDao,
    );
    bus = new AgentEventBus();
    service = new TaskSettleService(
      em,
      bus,
      runDao,
      taskDao,
      projectDao,
      tasks,
    );
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-settle-spec',
    });
    projectId = project.id;
  });

  /** A card already in `in_progress` with a live run working it. */
  const working = async (runId = 'run-1') => {
    const task = await tasks.create({ projectId, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      workflowId: null,
      status: 'running',
      agentKind: 'claude',
      taskId: task.id,
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  const settleRun = async (runId: string, status: RunStatus) => {
    const run = await runDao.getById(runId);
    if (run) {
      run.status = status;
      await em.flush();
    }
    await service.settle(runId, status);
  };

  /**
   * The card's status as the DATABASE holds it.
   *
   * Through a fresh fork, never the spec's shared `em`: that one's identity map
   * hands a second `getById` the entity the first one loaded, so a test reading
   * a card twice sees the first answer again.
   */
  const statusOf = async (taskId: string): Promise<string | undefined> =>
    (await taskDao.getById(taskId, orm.em.fork() as EntityManager))?.status;

  it('leaves a card whose run COMPLETED where it is, with no report written for the agent', async () => {
    // The agent moves its own card and writes its own report through
    // `update_task`. A run ending is not the task being finished, and the
    // thread's last message is not a report — it is whatever was said last.
    const task = await working();
    await itemDao.create({
      runId: 'run-1',
      seq: 1,
      kind: 'message',
      role: 'assistant',
      payload: '{"text":"let me check one more thing"}',
    });

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_progress');
    expect(stored?.report).toBeNull();
    expect(
      changes.filter((event) => event.taskId === task.id).at(-1),
    ).toMatchObject({ status: 'in_progress' });
  });

  it('leaves a card the agent already moved to review alone when its run completes', async () => {
    const task = await working();
    await tasks.update(task.id, { report: 'All done.' });
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.report).toBe('All done.');
    // A card in review is NOT finished: its run is a chat the user continues.
    expect(changes.at(-1)?.reason).toBeUndefined();
  });

  /**
   * The card's RESULT — the pull requests the work produced.
   *
   * Read from the RUN on every projection rather than stored on the task, so
   * these pin the projection and not a column.
   */
  describe('the card’s pull requests', () => {
    const captured = {
      owner: 'geniro-io',
      repo: 'geniro-app',
      number: 110,
      url: 'https://github.com/geniro-io/geniro-app/pull/110',
      seq: 12,
    };

    it('carries the pull requests its run opened, on both read paths', async () => {
      const task = await working();
      await runDao.updateById('run-1', {
        pullRequests: JSON.stringify([captured]),
      });

      const [listed] = await tasks.listForProject(projectId);
      expect(listed?.pullRequests).toEqual([captured]);
      expect((await tasks.get(task.id)).pullRequests).toEqual([captured]);
    });

    it('answers empty for a card whose run has been deleted', async () => {
      const task = await working();
      await runDao.updateById('run-1', {
        pullRequests: JSON.stringify([captured]),
      });
      await runDao.hardDeleteIncludingSoftDeleted({ id: 'run-1' });

      expect((await tasks.get(task.id)).pullRequests).toEqual([]);
      expect((await tasks.listForProject(projectId))[0]?.pullRequests).toEqual(
        [],
      );
    });
  });

  it('marks the card failed when the run fails', async () => {
    // An agent whose process died cannot call a tool — this one is the board's.
    const task = await working();

    await settleRun('run-1', 'failed');

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('returns the card to todo when the user stops the run themselves', async () => {
    const task = await working();

    await settleRun('run-1', 'cancelled');

    // A cancel is the user stopping their own agent — they did not fail at
    // anything, and the card has to be startable again.
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
  });

  it('does not mark a reviewed card failed when a follow-up turn fails', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await settleRun('run-1', 'failed');

    expect(await statusOf(task.id)).toBe('in_review');
  });

  it('leaves a card alone when it has moved on to a different run', async () => {
    const task = await working('run-old');
    // The card was re-started; an older run settling must not drag it back.
    await tasks.update(task.id, { runId: 'run-new' });

    await settleRun('run-old', 'failed');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('does nothing on a status the run has not settled into', async () => {
    const task = await working();

    await service.settle('run-1', 'running');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('reconciles a run that failed while the app was closed', async () => {
    const task = await working();
    // The settle happened with no window open, so nothing was broadcast: the
    // run row is terminal while the card still reads as working.
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }

    const board = await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
    expect(board.find((row) => row.id === task.id)?.status).toBe('failed');
  });

  it('leaves a still-running card alone when a board reconciles', async () => {
    const task = await working();

    await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('settles from the LIVE bus', async () => {
    const task = await working();
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }
    service.onModuleInit();

    bus.publishRunStatus({
      runId: 'run-1',
      status: 'failed',
      at: new Date().toISOString(),
    });
    // The subscriber detaches its work, so yield a full turn of the event
    // loop — every await under it resolves synchronously (better-sqlite3), so
    // one macrotask is enough for the whole chain.
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('ignores an activity announce, which asserts nothing about settling', async () => {
    const task = await working();
    service.onModuleInit();

    // A null status says only what the run is DOING.
    bus.publishRunStatus({
      runId: 'run-1',
      status: null,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  /** Announce a status for run-1 and let the detached subscriber finish. */
  const announce = async (status: RunStatus): Promise<void> => {
    bus.publishRunStatus({
      runId: 'run-1',
      status,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('puts a FAILED card back to work when its run works again', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });
    service.onModuleInit();

    // The user carried the conversation on in the chat itself.
    await announce('running');
    expect(await statusOf(task.id)).toBe('in_progress');

    // And a clean finish leaves it to the agent to move on from there.
    await announce('completed');
    expect(await statusOf(task.id)).toBe('in_progress');
  });

  it('leaves a card in review alone when its run works again', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    service.onModuleInit();

    await announce('running');

    expect(await statusOf(task.id)).toBe('in_review');
  });

  it('does not revive a failed card that has moved on to another run', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });
    await tasks.update(task.id, { runId: 'run-2' });
    service.onModuleInit();

    await announce('running');

    expect(await statusOf(task.id)).toBe('failed');
  });

  it('one contested card does not cost the board its whole listing', async () => {
    const task = await working();
    const other = await tasks.create({ projectId, title: 'untouched' });
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }
    // `settle` ends in a compare-and-set that throws when the row moved since
    // it was read — this is that throw, driven directly. `reconcileTasks` is
    // the board's ONLY listing call, so without the per-card catch this one
    // card takes every other one with it.
    const moved = vi
      .spyOn(tasks, 'moveStatus')
      .mockRejectedValueOnce(new Error('TASK_STATUS_CONFLICT'));

    const board = await service.reconcileProject(projectId);

    expect(moved).toHaveBeenCalledTimes(1);
    expect(board.map((r) => r.id)).toEqual(
      expect.arrayContaining([task.id, other.id]),
    );
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  // ── The failure breaker ────────────────────────────────────────────────────

  /**
   * Read the project back through a FRESH fork — `settle` writes on its own
   * fork, so the shared EM's identity map still holds the old row.
   */
  const freshProject = async (): Promise<Project> => {
    const fork = orm.em.fork() as EntityManager;
    return (await new ProjectDao(fork).getById(projectId, fork)) as Project;
  };

  const streak = async (): Promise<number> =>
    (await freshProject()).autopilotFailureStreak;

  const armProject = async (patch: {
    enabled?: boolean;
    streak?: number;
  }): Promise<void> => {
    const project = await projectDao.getById(projectId, em);
    if (patch.enabled !== undefined) {
      (project as Project).autopilotEnabled = patch.enabled;
    }
    if (patch.streak !== undefined) {
      (project as Project).autopilotFailureStreak = patch.streak;
    }
    await em.flush();
  };

  it('counts a failed run against an armed project', async () => {
    await armProject({ enabled: true });
    const task = await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(1);
    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('opens the breaker at the threshold, and not one failure sooner', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD - 2,
    });

    await working('run-a');
    await service.settle('run-a', 'failed');
    expect(isBreakerOpen(await freshProject())).toBe(false);

    await working('run-b');
    await service.settle('run-b', 'failed');
    expect(await streak()).toBe(PROJECT_FAILURE_BREAKER_THRESHOLD);
    expect(isBreakerOpen(await freshProject())).toBe(true);
  });

  it('clears the streak on a success', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD,
    });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  // The agent routinely moves its card to review BEFORE its turn ends, so a
  // success has to clear the streak whatever column the card reached.
  it('clears the streak on a success after the agent already moved the card', async () => {
    await armProject({ enabled: true, streak: 2 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  it('clears the streak on a success even while disarmed', async () => {
    await armProject({ enabled: false, streak: 2 });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  it('does not count a failure on a disarmed project', async () => {
    await armProject({ enabled: false, streak: 0 });
    await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(0);
  });

  // A follow-up turn failing in a thread already in review is not the task
  // failing, and the streak is a claim about unattended work.
  it('does not count a failure on a card that was no longer being worked', async () => {
    await armProject({ enabled: true, streak: 0 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(0);
  });

  it('leaves the streak alone when the user cancels', async () => {
    await armProject({ enabled: true, streak: 2 });
    await working();

    await service.settle('run-1', 'cancelled');

    expect(await streak()).toBe(2);
  });

  it('gives NO reason for a move to Done while the agent is still working', async () => {
    const task = await working();

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    // Were it to carry the reason, the renderer would remove the worktree of
    // an agent still working in it.
    expect(changes.at(-1)?.reason).toBeUndefined();
  });

  it('marks the work finished once the run settles under a card already in Done', async () => {
    const task = await working();
    // The agent's own `update_task` reaches `moveStatus` exactly as a drag does.
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    await settleRun('run-1', 'completed');

    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      status: 'done',
      reason: 'work-finished',
    });
    expect((await taskDao.getById(task.id))?.status).toBe('done');
  });

  it('marks the work finished when a settled card is moved to Done', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    await settleRun('run-1', 'completed');

    await tasks.moveStatus(task.id, { from: 'in_review', to: 'done' });

    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      status: 'done',
      reason: 'work-finished',
    });
  });

  it('releases a card whose run was deleted, keeping the report that is the card’s own', async () => {
    const task = await working();
    await tasks.update(task.id, { report: 'Half done — see the branch.' });
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    // Left holding the run, the card sits in `in_progress` for good with Run
    // disabled — the button asks the RUN, and a missing run is not a settled
    // one.
    expect(stored?.runId).toBeNull();
    expect(stored?.status).toBe('todo');
    expect(stored?.report).toBe('Half done — see the branch.');
  });

  it('leaves a REVIEWED card in its column when its run is deleted', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.runId).toBeNull();
  });

  it('ignores a deleted run no card ever held', async () => {
    const task = await working();
    service.onModuleInit();

    bus.publishRunDeleted('some-other-run');
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.runId).toBe('run-1');
  });
});
