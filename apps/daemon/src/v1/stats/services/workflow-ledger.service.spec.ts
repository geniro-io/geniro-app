import {
  defineConfig,
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

import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { Workflow } from '../../graphs/graphs.types';
import { workflowSnapshotOf } from '../../graphs/utils/workflow-snapshot';
import { workflowVersionOf } from '../../graphs/utils/workflow-version';
import { Run } from '../../runs/entity/run.entity';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { WorkflowVersion } from '../entity/workflow-version.entity';
import { WorkflowLedgerService } from './workflow-ledger.service';

const graph: Workflow = {
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'dev',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      name: 'Developer',
    },
    { id: 'qa', kind: 'agent', agent: 'codex', approval: 'auto' },
  ],
  edges: [
    { from: 'start', to: 'dev', kind: 'data' },
    { from: 'dev', to: 'qa', kind: 'data' },
  ],
};

/** Real DAOs on an in-memory database: the ledger's contract is how three tables line up. */
describe('WorkflowLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let bus: AgentEventBus;
  let runDao: RunDao;
  let activityDao: UsageActivityDao;
  let versionDao: WorkflowVersionDao;
  let service: WorkflowLedgerService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, UsageActivity, WorkflowVersion],
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
    const em = orm.em.fork();
    bus = new AgentEventBus();
    runDao = new RunDao(em);
    activityDao = new UsageActivityDao(em);
    versionDao = new WorkflowVersionDao(em);
    service = new WorkflowLedgerService(
      em,
      bus,
      runDao,
      activityDao,
      versionDao,
    );
  });

  async function workflowRun(
    id: string,
    options: {
      createdAt?: Date;
      snapshot?: string | null;
      workflowId?: string | null;
    } = {},
  ): Promise<void> {
    await runDao.create({
      id,
      workflowId:
        options.workflowId === undefined ? 'dev-team' : options.workflowId,
      status: 'completed',
      createdAt: options.createdAt ?? new Date('2026-10-01T10:00:00.000Z'),
      workflowSnapshot:
        options.snapshot === undefined
          ? workflowSnapshotOf(graph)
          : options.snapshot,
    });
  }

  async function created(id: string): Promise<void> {
    bus.publishRunCreated({ runId: id, createdAt: '' });
    await service.settled();
  }

  async function row(runId: string) {
    return (await activityDao.threadRowsByRuns([runId])).get(runId);
  }

  describe('live stamping', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it('stamps a created run with its workflow and version, and records the graph once', async () => {
      await workflowRun('run-1');
      await workflowRun('run-2');
      bus.publishRunCreated({ runId: 'run-1', createdAt: '' });
      bus.publishRunCreated({ runId: 'run-2', createdAt: '' });
      await service.settled();

      expect(await row('run-1')).toMatchObject({
        slug: 'dev-team',
        version: workflowVersionOf(graph),
        inferred: false,
      });
      expect(
        (await versionDao.graphsOf('dev-team')).map((v) => v.version),
      ).toEqual([workflowVersionOf(graph)]);
    });

    it('leaves a chat run alone', async () => {
      await workflowRun('chat-1', { workflowId: null, snapshot: null });
      await created('chat-1');

      expect(await row('chat-1')).toBeUndefined();
    });

    it('writes nothing for a run deleted before its announce was handled', async () => {
      await created('gone');

      expect(await row('gone')).toBeUndefined();
    });

    it('logs a failed stamp instead of throwing it into the bus', async () => {
      await workflowRun('run-1');
      vi.spyOn(activityDao, 'stampThreadVersion').mockRejectedValueOnce(
        new Error('disk gone'),
      );

      await created('run-1');

      expect(await row('run-1')).toBeUndefined();
    });
  });

  describe('sweep', () => {
    it('stamps every unversioned run, marking pre-snapshot runs inferred and copy-less runs slug only', async () => {
      await workflowRun('fresh');
      await workflowRun('old', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
      });
      await workflowRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
      });
      await workflowRun('unreadable', { snapshot: '{"nodes":"no"}' });
      await workflowRun('chat', { workflowId: null, snapshot: null });

      expect(await service.sweep()).toEqual({ versions: 4 });

      expect(await row('fresh')).toMatchObject({
        version: workflowVersionOf(graph),
        inferred: false,
      });
      expect(await row('old')).toMatchObject({
        version: workflowVersionOf(graph),
        inferred: true,
      });
      expect(await row('copyless')).toMatchObject({
        slug: 'dev-team',
        version: null,
        inferred: null,
      });
      expect(await row('unreadable')).toMatchObject({
        slug: 'dev-team',
        version: null,
      });
      expect(await row('chat')).toBeUndefined();
    });

    it('registers a version first seen by a genuine run, never by an inferred one', async () => {
      const later: Workflow = {
        ...graph,
        nodes: [
          ...graph.nodes,
          { id: 'qa2', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
      };
      await workflowRun('old', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
        snapshot: workflowSnapshotOf(later),
      });
      await workflowRun('fresh', {
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      });

      await service.sweep();

      expect(await versionDao.graphsOf('dev-team')).toEqual([
        {
          version: workflowVersionOf(graph),
          graph: expect.any(String),
          firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
        },
      ]);
      expect(await row('old')).toMatchObject({
        version: workflowVersionOf(later),
        inferred: true,
      });
    });

    it('logs a run it cannot stamp and stamps the rest', async () => {
      await workflowRun('broken');
      await workflowRun('fine');
      const stamp = activityDao.stampThreadVersion.bind(activityDao);
      vi.spyOn(activityDao, 'stampThreadVersion').mockImplementation(
        async (runId, ...rest) => {
          if (runId === 'broken') {
            throw new Error('disk gone');
          }
          return stamp(runId, ...rest);
        },
      );

      await expect(service.sweep()).resolves.toEqual({ versions: 1 });
      expect((await row('fine'))?.version).toBe(workflowVersionOf(graph));
      expect((await row('broken'))?.version ?? null).toBeNull();
    });

    it('writes nothing on a second call', async () => {
      await workflowRun('fresh');
      await workflowRun('copyless', { snapshot: null });
      await service.sweep();

      expect(await service.sweep()).toEqual({ versions: 0 });
    });

    it('keeps a copy-less run slug-only after a later read freezes the library graph into it', async () => {
      await workflowRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
      });
      await service.sweep();
      await runDao.updateById(
        'copyless',
        { workflowSnapshot: workflowSnapshotOf(graph) },
        orm.em.fork(),
      );

      expect(await service.sweep()).toEqual({ versions: 0 });
      expect((await row('copyless'))?.version).toBeNull();
      expect(await versionDao.graphsOf('dev-team')).toEqual([]);
    });
  });
});
