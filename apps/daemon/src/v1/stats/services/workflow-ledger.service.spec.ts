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

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { Workflow } from '../../graphs/graphs.types';
import { workflowSnapshotOf } from '../../graphs/utils/workflow-snapshot';
import { workflowVersionOf } from '../../graphs/utils/workflow-version';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { RunStatus } from '../../runs/runs.types';
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

/** Real DAOs on an in-memory database: the ledger's contract is how five tables line up. */
describe('WorkflowLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let bus: AgentEventBus;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let activityDao: UsageActivityDao;
  let versionDao: WorkflowVersionDao;
  let service: WorkflowLedgerService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, NodeState, UsageActivity, WorkflowVersion],
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
    nodeStateDao = new NodeStateDao(em);
    activityDao = new UsageActivityDao(em);
    versionDao = new WorkflowVersionDao(em);
    service = new WorkflowLedgerService(
      em,
      bus,
      runDao,
      nodeStateDao,
      activityDao,
      versionDao,
    );
  });

  async function workflowRun(
    id: string,
    options: {
      createdAt?: Date;
      snapshot?: string | null;
      status?: RunStatus;
      workflowId?: string | null;
    } = {},
  ): Promise<void> {
    await runDao.create({
      id,
      workflowId:
        options.workflowId === undefined ? 'dev-team' : options.workflowId,
      status: options.status ?? 'running',
      createdAt: options.createdAt ?? new Date('2026-10-01T10:00:00.000Z'),
      workflowSnapshot:
        options.snapshot === undefined
          ? workflowSnapshotOf(graph)
          : options.snapshot,
    });
    // The executor writes a row per runnable node when it creates a run.
    await nodeStateDao.createPending(id, 'start');
  }

  async function settle(id: string, status: RunStatus): Promise<void> {
    await runDao.updateById(id, { status }, orm.em.fork());
    bus.publishRunStatus({ runId: id, status });
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
      bus.publishRunCreated({ runId: 'chat-1', createdAt: '' });
      await settle('chat-1', 'completed');

      expect(await row('chat-1')).toBeUndefined();
    });

    it('stamps the outcome: status, failed nodes without the interrupted ones, and wall time', async () => {
      await workflowRun('run-1');
      bus.publishRunCreated({ runId: 'run-1', createdAt: '' });
      await nodeStateDao.create({
        runId: 'run-1',
        nodeId: 'dev',
        status: 'failed',
        error: 'exit 1',
      });
      await nodeStateDao.create({
        runId: 'run-1',
        nodeId: 'qa',
        status: 'failed',
        error: 'interrupted',
      });
      await nodeStateDao.create({
        runId: 'run-1',
        nodeId: 'start',
        status: 'completed',
      });
      await settle('run-1', 'failed');

      expect(await row('run-1')).toMatchObject({
        version: workflowVersionOf(graph),
        runStatus: 'failed',
        failedNodes: [{ nodeId: 'dev', name: 'Developer' }],
      });
    });

    it('overwrites the outcome when a reopened run settles again', async () => {
      await workflowRun('run-1');
      await nodeStateDao.create({
        runId: 'run-1',
        nodeId: 'dev',
        status: 'failed',
        error: 'exit 1',
      });
      await settle('run-1', 'failed');
      await orm.em
        .fork()
        .nativeUpdate(
          NodeState,
          { runId: 'run-1', nodeId: 'dev' },
          { status: 'completed', error: null },
        );

      await settle('run-1', 'completed');

      expect(await row('run-1')).toMatchObject({
        runStatus: 'completed',
        failedNodes: [],
      });
    });

    describe('a delete purging the run while its last settle is being stamped', () => {
      /** The teardown's purge, landing right after the handler has read the run. */
      function purgeAfterTheRunIsRead(): void {
        const read = runDao.runFacts.bind(runDao);
        vi.spyOn(runDao, 'runFacts').mockImplementationOnce(async (...args) => {
          const facts = await read(...args);
          const em = orm.em.fork();
          await em.nativeDelete(NodeState, { runId: 'run-1' });
          await em.nativeDelete(Run, { id: 'run-1' });
          return facts;
        });
      }

      beforeEach(async () => {
        await workflowRun('run-1');
        await nodeStateDao.create({
          runId: 'run-1',
          nodeId: 'dev',
          status: 'failed',
          error: 'exit 1',
        });
        await settle('run-1', 'failed');
      });

      it('keeps the earlier stamp when the run is gone by the time its rows are read', async () => {
        purgeAfterTheRunIsRead();

        await settle('run-1', 'cancelled');

        expect(await row('run-1')).toMatchObject({
          runStatus: 'failed',
          failedNodes: [{ nodeId: 'dev', name: 'Developer' }],
        });
      });

      it('keeps the stamped failed nodes when the purge takes the node rows between the reads', async () => {
        const read = nodeStateDao.failedByRuns.bind(nodeStateDao);
        vi.spyOn(nodeStateDao, 'failedByRuns').mockImplementationOnce(
          async (...args) => {
            await orm.em.fork().nativeDelete(NodeState, { runId: 'run-1' });
            return read(...args);
          },
        );

        await settle('run-1', 'cancelled');

        expect(await row('run-1')).toMatchObject({
          runStatus: 'failed',
          failedNodes: [{ nodeId: 'dev', name: 'Developer' }],
        });
      });
    });

    it('ends stamped when the settle is announced ahead of the creation', async () => {
      await workflowRun('run-1', { status: 'completed' });
      bus.publishRunStatus({ runId: 'run-1', status: 'completed' });
      bus.publishRunCreated({ runId: 'run-1', createdAt: '' });
      await service.settled();

      expect(await row('run-1')).toMatchObject({
        version: workflowVersionOf(graph),
        runStatus: 'completed',
      });
    });

    it('writes no outcome for a run whose row is gone, keeping the earlier stamp', async () => {
      await workflowRun('run-1');
      await settle('run-1', 'failed');
      await orm.em.fork().nativeDelete(Run, { id: 'run-1' });

      bus.publishRunStatus({ runId: 'run-1', status: 'cancelled' });
      await service.settled();

      expect((await row('run-1'))?.runStatus).toBe('failed');
    });

    it('ignores a status that is not an ending', async () => {
      await workflowRun('run-1');
      bus.publishRunStatus({ runId: 'run-1', status: 'running' });
      await service.settled();

      expect(await row('run-1')).toBeUndefined();
    });
  });

  describe('sweep', () => {
    it('stamps every unversioned run, marking pre-snapshot runs inferred and copy-less runs slug only', async () => {
      await workflowRun('fresh', { status: 'completed' });
      await workflowRun('old', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
        status: 'failed',
      });
      await workflowRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
        status: 'completed',
      });
      await workflowRun('unreadable', { snapshot: '{"nodes":"no"}' });
      await workflowRun('chat', { workflowId: null, snapshot: null });

      expect(await service.sweep()).toEqual({ versions: 4, outcomes: 3 });

      expect(await row('fresh')).toMatchObject({
        version: workflowVersionOf(graph),
        inferred: false,
        runStatus: 'completed',
      });
      expect(await row('old')).toMatchObject({
        version: workflowVersionOf(graph),
        inferred: true,
        runStatus: 'failed',
      });
      expect(await row('copyless')).toMatchObject({
        slug: 'dev-team',
        version: null,
        inferred: null,
      });
      expect(await row('unreadable')).toMatchObject({
        slug: 'dev-team',
        version: null,
        runStatus: null,
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
        status: 'completed',
      });
      await workflowRun('fresh', {
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        status: 'completed',
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
      await workflowRun('broken', { status: 'completed' });
      await workflowRun('fine', { status: 'completed' });
      const stamp = activityDao.stampThreadVersion.bind(activityDao);
      vi.spyOn(activityDao, 'stampThreadVersion').mockImplementation(
        async (runId, ...rest) => {
          if (runId === 'broken') {
            throw new Error('disk gone');
          }
          return stamp(runId, ...rest);
        },
      );

      await expect(service.sweep()).resolves.toEqual({
        versions: 1,
        outcomes: 2,
      });
      expect((await row('fine'))?.version).toBe(workflowVersionOf(graph));
      expect((await row('broken'))?.version ?? null).toBeNull();
    });

    it('re-stamps a settled run whose stamped status is stale, and stops once all are current', async () => {
      await workflowRun('run-1', { status: 'completed' });
      await service.sweep();
      await runDao.updateById('run-1', { status: 'failed' }, orm.em.fork());

      expect(await service.sweep()).toEqual({ versions: 0, outcomes: 1 });
      expect((await row('run-1'))?.runStatus).toBe('failed');
    });

    it('stamps a run that failed before it had node rows, once', async () => {
      await workflowRun('early', { status: 'failed' });
      await orm.em.fork().nativeDelete(NodeState, { runId: 'early' });

      expect(await service.sweep()).toEqual({ versions: 1, outcomes: 1 });
      expect(await row('early')).toMatchObject({
        runStatus: 'failed',
        failedNodes: [],
      });
      expect(await service.sweep()).toEqual({ versions: 0, outcomes: 0 });
    });

    it('writes nothing on a second call', async () => {
      await workflowRun('fresh', { status: 'completed' });
      await workflowRun('copyless', { snapshot: null, status: 'completed' });
      await service.sweep();

      expect(await service.sweep()).toEqual({ versions: 0, outcomes: 0 });
    });

    it('keeps a copy-less run slug-only after a later read freezes the library graph into it', async () => {
      await workflowRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
        status: 'completed',
      });
      await service.sweep();
      await runDao.updateById(
        'copyless',
        { workflowSnapshot: workflowSnapshotOf(graph) },
        orm.em.fork(),
      );

      expect(await service.sweep()).toEqual({ versions: 0, outcomes: 0 });
      expect((await row('copyless'))?.version).toBeNull();
      expect(await versionDao.graphsOf('dev-team')).toEqual([]);
    });
  });
});
