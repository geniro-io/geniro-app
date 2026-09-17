import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskBoardToolService } from './task-board-tool.service';
import { TaskEventBus } from './task-events.bus';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/** Where this spec's copied screenshots land — removed after each case. */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-board-tool-spec');

describe('TaskBoardToolService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let broker: TaskBoardBroker;
  let service: TaskBoardToolService;
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
    rmSync(ATTACHMENTS_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    const projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    const events = new TaskEventBus();
    changes = [];
    events.allChanges().subscribe((event) => changes.push(event));
    const attachments = new TaskAttachmentService(ATTACHMENTS_ROOT);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      events,
      attachments,
      runDao,
    );
    broker = new TaskBoardBroker();
    service = new TaskBoardToolService(
      em,
      broker,
      runDao,
      taskDao,
      tasks,
      attachments,
      new TaskFilesService(em, taskDao, tasks),
    );
    service.onModuleInit();
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-board-tool-spec',
    });
    projectId = project.id;
  });

  /** A card in `in_progress`, worked by `runId`. */
  const working = async (runId = 'run-1') => {
    const task = await tasks.create({ projectId, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      workflowId: null,
      status: 'running',
      agentKind: 'claude',
      taskId: task.id,
      taskIdentifier: 'GEN-7',
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  const fresh = async (taskId: string) =>
    taskDao.getById(taskId, orm.em.fork() as EntityManager);

  it('reads the card its run works — through the broker the MCP host asks', async () => {
    await working();

    expect(await broker.cardFor('run-1')).toEqual({
      identifier: 'GEN-7',
      title: 'ship it',
      description: null,
      status: 'in_progress',
      report: null,
    });
    expect(await broker.cardFor('no-such-run')).toBeNull();
  });

  it('writes the report and moves the card, in that order', async () => {
    const task = await working();

    const outcome = await broker.update('run-1', {
      report: '## Done\n\nShipped it.',
      status: 'in_review',
    });

    expect(outcome).toMatchObject({
      status: 'updated',
      card: { status: 'in_review', report: '## Done\n\nShipped it.' },
    });
    const stored = await fresh(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.report).toBe('## Done\n\nShipped it.');
    expect(stored?.reportedAt).toBeInstanceOf(Date);
    // The card lands in its new column already carrying the report: the last
    // two broadcasts are the report write, then the move.
    expect(changes.slice(-2).map((event) => event.status)).toEqual([
      'in_progress',
      'in_review',
    ]);
  });

  it('copies referenced screenshots onto the card and points the report at the copies', async () => {
    const task = await working();
    const scratch = mkdtempSync(join(tmpdir(), 'geniro-board-shots-'));
    const shot = join(scratch, 'panel.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(shot, bytes);
    try {
      const report = `Done.\n\n![the panel](${shot})\n![gone](/nope/missing.png)`;

      const outcome = await broker.update('run-1', { report });

      expect(outcome).toMatchObject({
        attachedImages: 1,
        skippedImages: ['/nope/missing.png'],
      });
      const files = (await tasks.get(task.id)).attachments;
      expect(files.map((file) => file.name)).toEqual(['panel.png']);
      const copy = files[0]!.path;
      expect(copy.startsWith(join(ATTACHMENTS_ROOT, task.id))).toBe(true);
      expect(readFileSync(copy)).toEqual(bytes);
      // The scratch path is reaped next week; the card's copy is not.
      const stored = (await fresh(task.id))?.report ?? '';
      expect(stored).toContain(`![the panel](${copy})`);
      expect(stored).not.toContain(shot);
      // The picture that could not be copied stays referenced as written.
      expect(stored).toContain('![gone](/nope/missing.png)');

      // Every report replaces the last, so the same screenshot sent again must
      // not be listed on the card twice.
      await broker.update('run-1', { report });
      expect((await tasks.get(task.id)).attachments).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a run whose card has since been started on another run', async () => {
    const task = await working('run-old');
    await tasks.update(task.id, { runId: 'run-new' });

    const outcome = await broker.update('run-old', { status: 'done' });

    expect(outcome.status).toBe('refused');
    expect(await broker.cardFor('run-old')).toBeNull();
    expect((await fresh(task.id))?.status).toBe('in_progress');
  });

  it('leaves the board unanswerable once the module is destroyed', async () => {
    await working();

    service.onModuleDestroy();

    expect(await broker.cardFor('run-1')).toBeNull();
    expect(await broker.update('run-1', { status: 'done' })).toEqual({
      status: 'refused',
      reason: 'the task board is not available',
    });
  });
});
