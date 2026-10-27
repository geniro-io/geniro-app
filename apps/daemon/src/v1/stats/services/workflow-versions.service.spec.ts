import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
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
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { Workflow } from '../../graphs/graphs.types';
import type { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { workflowVersionOf } from '../../graphs/utils/workflow-version';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import { WorkflowVersion } from '../entity/workflow-version.entity';
import type { UsageEventInput } from '../stats.types';
import { WorkflowVersionsService } from './workflow-versions.service';

const graph: Workflow = {
  name: 'Dev Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};
const VERSION = workflowVersionOf(graph);

/** Real DAOs on an in-memory database: what this service adds is which rows it reads. */
describe('WorkflowVersionsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let runDao: RunDao;
  let get: ReturnType<typeof vi.fn>;
  let service: WorkflowVersionsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, NodeState, UsageActivity, UsageEvent, WorkflowVersion],
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
    activityDao = new UsageActivityDao(em);
    usageDao = new UsageEventDao(em);
    runDao = new RunDao(em);
    get = vi.fn(async () => ({ slug: 'dev-team', workflow: graph, hash: 'h' }));
    service = new WorkflowVersionsService(
      em,
      activityDao,
      usageDao,
      new WorkflowVersionDao(em),
      runDao,
      new NodeStateDao(em),
      { all: () => new Map() } as unknown as AgentAdapterRegistry,
      { get } as unknown as WorkflowStoreService,
    );
  });

  const created = new Date('2026-10-01T10:00:00.000Z');

  async function workflowThread(runId: string, live: boolean): Promise<void> {
    await activityDao.stampThreadVersion(runId, created, {
      slug: 'dev-team',
      version: VERSION,
      inferred: false,
    });
    if (live) {
      await runDao.create({
        id: runId,
        workflowId: 'dev-team',
        status: 'completed',
        createdAt: created,
      });
    }
  }

  function turn(runId: string, costUsd: number): UsageEventInput {
    return {
      runId,
      nodeId: 'start',
      seq: 1,
      occurredAt: created,
      agentKind: 'claude',
      model: null,
      cwd: null,
      workflowName: 'Dev Team',
      costUsd,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: 1000,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    };
  }

  it('reads a deleted run’s spend from the ledger, beside a live one', async () => {
    await workflowThread('live', true);
    await workflowThread('gone', false);
    await usageDao.recordOnce(turn('live', 2));
    await usageDao.recordOnce(turn('gone', 3));

    const result = await service.read('dev-team');

    const runs = result.versions[0]!.runs;
    expect(runs.find((run) => run.runId === 'gone')).toMatchObject({
      deleted: true,
      costUsd: 3,
    });
    expect(runs.find((run) => run.runId === 'live')).toMatchObject({
      deleted: false,
      costUsd: 2,
    });
    expect(result.totals.totals.costUsd).toBe(5);
    expect(result.currentVersion).toBe(VERSION);
  });

  it('counts every run past the first batch of ids', async () => {
    for (let index = 0; index < 501; index += 1) {
      await workflowThread(`run-${index}`, false);
    }
    await usageDao.recordOnce(turn('run-500', 7));

    const result = await service.read('dev-team');

    expect(result.totals.runs).toBe(501);
    expect(result.totals.totals.costUsd).toBe(7);
  });

  it('names no current version when the library file is gone', async () => {
    await workflowThread('live', true);
    get.mockRejectedValueOnce(new NotFoundException('WORKFLOW_NOT_FOUND'));

    expect((await service.read('dev-team')).currentVersion).toBeNull();
  });
});
