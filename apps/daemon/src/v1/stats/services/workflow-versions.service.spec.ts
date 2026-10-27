import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { Workflow } from '../../graphs/graphs.types';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
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
  let versionDao: WorkflowVersionDao;
  let get: ReturnType<typeof vi.fn>;
  let service: WorkflowVersionsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity, UsageEvent, WorkflowVersion],
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
    versionDao = new WorkflowVersionDao(em);
    get = vi.fn(async () => ({ slug: 'dev-team', workflow: graph, hash: 'h' }));
    service = new WorkflowVersionsService(
      em,
      activityDao,
      usageDao,
      versionDao,
      { all: () => new Map() } as unknown as AgentAdapterRegistry,
      { get } as unknown as WorkflowStoreService,
    );
  });

  const created = new Date('2026-10-01T10:00:00.000Z');

  async function workflowThread(
    runId: string,
    version = VERSION,
    at = created,
  ): Promise<void> {
    await activityDao.stampThreadVersion(runId, at, {
      slug: 'dev-team',
      version,
      inferred: false,
    });
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

  it('counts a run whose chat is gone through what the ledger kept', async () => {
    await workflowThread('gone');
    await workflowThread('kept');
    await usageDao.recordOnce(turn('gone', 3));
    await usageDao.recordOnce(turn('kept', 1));

    const result = await service.read('dev-team');

    expect(result.versions[0]!.figures).toMatchObject({
      runs: 2,
      costUsd: 4,
      avgCostUsd: 2,
    });
    expect(result.currentVersion).toBe(VERSION);
  });

  it('counts every run past the first batch of ids', async () => {
    for (let index = 0; index < 501; index += 1) {
      await workflowThread(`run-${index}`);
    }
    await usageDao.recordOnce(turn('run-500', 7));

    const result = await service.read('dev-team');

    expect(result.totals.runs).toBe(501);
    expect(result.totals.costUsd).toBe(7);
  });

  it('diffs a version’s graph against the one recorded before it', async () => {
    const next: Workflow = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: 'qa', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
    };
    const NEXT = workflowVersionOf(next);
    for (const [workflow, version, at] of [
      [graph, VERSION, created],
      [next, NEXT, new Date('2026-10-02T10:00:00.000Z')],
    ] as const) {
      await versionDao.register(
        'dev-team',
        version,
        canonicalGraphJson(canonicalGraphOf(workflow)),
        at,
      );
      await workflowThread(`run-${version}`, version, at);
    }

    const [newest, oldest] = (await service.read('dev-team')).versions;

    expect(oldest!.changes).toBeNull();
    expect(newest!.changes).toMatchObject({ removed: 0 });
    expect(newest!.changes!.added).toBeGreaterThan(0);
    expect(newest!.changes!.diff).toContain('+  - id: qa');
  });

  it('names no current version when the library file is gone', async () => {
    await workflowThread('run-1');
    get.mockRejectedValueOnce(new NotFoundException('WORKFLOW_NOT_FOUND'));

    expect((await service.read('dev-team')).currentVersion).toBeNull();
  });

  describe('restore', () => {
    let dir: string;
    let store: WorkflowStoreService;
    let restoring: WorkflowVersionsService;

    const older: Workflow = {
      name: 'Old name',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [{ from: 'start', to: 'dev', kind: 'data' }],
    };
    const newer: Workflow = {
      name: 'Dev Team',
      description: 'Ships things',
      maxActiveTurns: 2,
      nodes: [
        ...older.nodes,
        { id: 'qa', kind: 'agent', agent: 'codex', approval: 'auto' },
      ],
      edges: [
        { from: 'start', to: 'dev', kind: 'data', label: 'brief' },
        { from: 'dev', to: 'qa', kind: 'call' },
      ],
      layout: {
        start: { x: 0, y: 0 },
        dev: { x: 100, y: 0 },
        qa: { x: 200, y: 0 },
      },
    };
    const OLDER = workflowVersionOf(older);

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'geniro-restore-'));
      store = new WorkflowStoreService({ workflowsDir: dir });
      await store.save('dev-team', newer);
      await versionDao.register(
        'dev-team',
        OLDER,
        canonicalGraphJson(canonicalGraphOf(older)),
        created,
      );
      restoring = new WorkflowVersionsService(
        orm.em.fork(),
        activityDao,
        usageDao,
        versionDao,
        { all: () => new Map() } as unknown as AgentAdapterRegistry,
        store,
      );
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the version’s graph, keeping the name, description, places and labels, and backs the old file up', async () => {
      const before = await readFile(join(dir, 'dev-team.geniro.yaml'), 'utf8');
      const { hash } = await store.get('dev-team');

      const restored = await restoring.restore('dev-team', OLDER, hash);

      const { workflow } = await store.get('dev-team');
      expect(restored.version).toBe(OLDER);
      expect(workflowVersionOf(workflow)).toBe(OLDER);
      expect(workflow).toMatchObject({
        name: 'Dev Team',
        description: 'Ships things',
        layout: { start: { x: 0, y: 0 }, dev: { x: 100, y: 0 } },
        edges: [{ from: 'start', to: 'dev', kind: 'data', label: 'brief' }],
      });
      expect(workflow.maxActiveTurns).toBeUndefined();
      expect(workflow.layout).not.toHaveProperty('qa');
      expect(restored.hash).toBe((await store.get('dev-team')).hash);
      expect(restored.backup).toMatch(/^\.backups\/dev-team\..+\.yaml$/);
      expect(await readFile(join(dir, restored.backup), 'utf8')).toBe(before);
    });

    it('refuses a copy read before the file changed, writing nothing', async () => {
      const { hash } = await store.get('dev-team');
      await store.save('dev-team', { ...newer, description: 'Edited since' });

      await expect(
        restoring.restore('dev-team', OLDER, hash),
      ).rejects.toMatchObject({ errorCode: 'WORKFLOW_CHANGED' });
      expect(workflowVersionOf((await store.get('dev-team')).workflow)).toBe(
        workflowVersionOf(newer),
      );
      expect(await readdir(dir)).not.toContain('.backups');
    });

    it('refuses a version whose graph was never recorded', async () => {
      await expect(
        restoring.restore('dev-team', 'ffffffffffffffff', undefined),
      ).rejects.toMatchObject({ errorCode: 'WORKFLOW_VERSION_NOT_FOUND' });
    });

    it('refuses a workflow that is gone from the library', async () => {
      await store.delete('dev-team');

      await expect(
        restoring.restore('dev-team', OLDER, undefined),
      ).rejects.toMatchObject({ errorCode: 'WORKFLOW_NOT_FOUND' });
    });
  });
});
