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
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { TASKS_AWAITING_MERGE_MAX } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskMergeService } from './task-merge.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout, on `task-settle.service.spec.ts`' own reasoning:
 * what is under test is which cards are handed out and where one lands, both
 * of which are reads of stored state.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-merge-spec');

const PR_URL = 'https://github.com/geniro-io/geniro-app/pull/7';

describe('TaskMergeService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskMergeService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let projectId: string;
  let runSeq = 0;

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
    runSeq = 0;
    taskDao = new TaskDao(em);
    runDao = new RunDao(em);
    const projectDao = new ProjectDao(em);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      runDao,
    );
    service = new TaskMergeService(em, taskDao, runDao, tasks);
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-merge-spec',
    });
    projectId = project.id;
  });

  /** A card in review, whose run captured `urls` as the pull requests it opened. */
  const inReview = async (urls: string[] = [PR_URL], title = 'ship it') => {
    runSeq += 1;
    const runId = `run-${runSeq}`;
    const task = await tasks.create({ projectId, title });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      workflowId: null,
      status: 'completed',
      agentKind: 'claude',
      taskId: task.id,
      pullRequests: JSON.stringify(
        urls.map((url, index) => ({
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 7 + index,
          url,
          seq: index,
        })),
      ),
    });
    await tasks.update(task.id, { runId });
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    return { task, runId };
  };

  describe('listAwaitingMerge', () => {
    it('hands out a card in review with the pull requests its run opened', async () => {
      const { task } = await inReview();

      expect(await service.listAwaitingMerge()).toEqual([
        {
          taskId: task.id,
          projectId,
          title: 'ship it',
          pullRequests: [
            {
              owner: 'geniro-io',
              repo: 'geniro-app',
              number: 7,
              url: PR_URL,
              seq: 0,
            },
          ],
        },
      ]);
    });

    it('leaves out a card whose run opened nothing', async () => {
      await inReview([]);

      // The caller's only use for a row is to ask GitHub about it, so a card
      // it can ask nothing about is a lookup paid for no possible answer.
      expect(await service.listAwaitingMerge()).toEqual([]);
    });

    it('leaves out a card that is not in review', async () => {
      const { task } = await inReview();
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'todo' });

      expect(await service.listAwaitingMerge()).toEqual([]);
    });

    it('caps how many cards one sweep hands out', async () => {
      for (let index = 0; index <= TASKS_AWAITING_MERGE_MAX; index += 1) {
        await inReview([`${PR_URL}${index}`], `card ${index}`);
      }

      // An unattended tick must not grow with a column somebody left in review
      // for a year — each card costs the watcher a lookup against GitHub.
      expect(await service.listAwaitingMerge()).toHaveLength(
        TASKS_AWAITING_MERGE_MAX,
      );
    });
  });

  describe('settleMerged', () => {
    it('ends a card in review whose pull request was merged', async () => {
      const { task } = await inReview();

      const moved = await service.settleMerged(task.id, PR_URL);

      expect(moved.status).toBe('done');
      expect((await tasks.get(task.id)).status).toBe('done');
    });

    it('leaves a card the user has already moved on where it is', async () => {
      const { task } = await inReview();
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'todo' });

      // An ordinary race: the sweep runs on a timer against a board somebody
      // is using. Ending it anyway would drag the card out of the column they
      // just chose for it.
      const answered = await service.settleMerged(task.id, PR_URL);

      expect(answered.status).toBe('todo');
    });

    it('refuses a pull request this card never opened', async () => {
      const { task } = await inReview();

      // Not a race — a caller reporting about the wrong card, which would end
      // work nobody finished.
      await expect(
        service.settleMerged(task.id, 'https://github.com/other/repo/pull/1'),
      ).rejects.toThrow(/TASK_PULL_REQUEST_UNKNOWN|did not open/u);
      expect((await tasks.get(task.id)).status).toBe('in_review');
    });

    it('refuses a card that no longer exists', async () => {
      await expect(service.settleMerged('nope', PR_URL)).rejects.toThrow(
        /TASK_NOT_FOUND|not found/u,
      );
    });
  });
});
