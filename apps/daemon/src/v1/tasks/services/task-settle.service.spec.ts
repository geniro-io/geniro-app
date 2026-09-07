import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind, RunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { TaskEventBus } from './task-events.bus';
import { TaskSettleService } from './task-settle.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout. What is under test is where a card lands and which
 * transcript row is recorded as its report — both are reads of stored state,
 * so faking the store would leave nothing to observe.
 */
describe('TaskSettleService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskSettleService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let itemDao: ItemDao;
  let em: EntityManager;
  let projectId: string;
  let seq = 0;

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
    seq = 0;
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    itemDao = new ItemDao(em);
    tasks = new TasksService(em, taskDao, projectDao, new TaskEventBus());
    service = new TaskSettleService(
      em,
      new AgentEventBus(),
      runDao,
      itemDao,
      taskDao,
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

  const row = async (
    runId: string,
    kind: ItemKind,
    role: string | null,
    payload: string,
  ) => {
    seq += 1;
    return itemDao.create({ runId, seq, kind, role, payload });
  };

  const settleRun = async (runId: string, status: RunStatus) => {
    const run = await runDao.getById(runId);
    if (run) {
      run.status = status;
      await em.flush();
    }
    await service.settle(runId, status);
  };

  it('moves the card to review and records the structured report', async () => {
    const task = await working();
    await row('run-1', 'message', 'assistant', '{"text":"working on it"}');
    const report = await row(
      'run-1',
      'report_findings',
      null,
      '{"findings":[]}',
    );

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.reportItemId).toBe(report.id);
  });

  it('falls back to the agent’s last message when no report was emitted', async () => {
    const task = await working();
    await row('run-1', 'message', 'assistant', '{"text":"first"}');
    const last = await row('run-1', 'message', 'assistant', '{"text":"done"}');

    await settleRun('run-1', 'completed');

    expect((await taskDao.getById(task.id))?.reportItemId).toBe(last.id);
  });

  it('never reports the USER’s own message back as the agent’s report', async () => {
    const task = await working();
    const agent = await row('run-1', 'message', 'assistant', '{"text":"done"}');
    // The user replies after the agent's last word — newest, and not a report.
    await row('run-1', 'message', 'user', '{"text":"thanks"}');

    await settleRun('run-1', 'completed');

    expect((await taskDao.getById(task.id))?.reportItemId).toBe(agent.id);
  });

  it('marks the card failed when the run fails', async () => {
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

  it('leaves a card alone when it has moved on to a different run', async () => {
    const task = await working('run-old');
    // The card was re-started; an older run settling must not drag it back.
    await tasks.update(task.id, { runId: 'run-new' });

    await settleRun('run-old', 'completed');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('does nothing on a status the run has not settled into', async () => {
    const task = await working();

    await service.settle('run-1', 'running');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('reconciles a run that settled while the app was closed, WITH its report', async () => {
    const task = await working();
    const last = await row(
      'run-1',
      'message',
      'assistant',
      '{"text":"all done"}',
    );
    // The settle happened with no window open, so nothing was broadcast: the
    // run row is terminal while the card still reads as working.
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'completed';
      await em.flush();
    }

    const board = await service.reconcileProject(projectId);

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    // The point of the whole exercise: the closing words rode an event that is
    // long gone, so a reconcile reading only the status would land an EMPTY
    // report. It reads the transcript instead.
    expect(stored?.reportItemId).toBe(last.id);
    expect(board.find((row) => row.id === task.id)?.status).toBe('in_review');
  });

  it('leaves a still-running card alone when a board reconciles', async () => {
    const task = await working();

    await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });
});
