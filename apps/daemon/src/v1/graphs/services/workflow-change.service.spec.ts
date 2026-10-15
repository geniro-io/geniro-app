import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { Workflow } from '../graphs.types';
import { workflowSnapshotOf } from '../utils/workflow-snapshot';
import {
  WORKFLOW_BACKUP_DIR,
  type WorkflowChange,
  WorkflowChangeService,
} from './workflow-change.service';
import { WorkflowStoreService } from './workflow-store.service';

const WF: Workflow = {
  name: 'Dev Team',
  nodes: [
    { id: 'builder', kind: 'agent', agent: 'claude', approval: 'auto' },
    { id: 'reviewer', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'builder', to: 'reviewer', kind: 'data' as const }],
};

const FASTER: Workflow = {
  ...WF,
  nodes: [
    WF.nodes[0]!,
    { ...WF.nodes[1]!, model: 'sonnet' } as Workflow['nodes'][number],
  ],
};

describe('WorkflowChangeService', () => {
  let dir: string;
  let store: WorkflowStoreService;
  let applies: unknown[];
  let service: WorkflowChangeService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-change-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
    await store.create(WF, 'dev-team');
    applies = [{ cardSeq: 3, ids: ['W-1', 'W-2'] }];
    service = new WorkflowChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {
        userMessagesInOrder: () =>
          Promise.resolve([
            { seq: 0, payload: JSON.stringify({ text: 'analyse' }) },
            ...applies.map((apply, index) => ({
              seq: index + 1,
              payload: JSON.stringify({ text: 'apply', apply }),
            })),
          ]),
      } as unknown as ItemDao,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function hash(): Promise<string> {
    return (await service.describe('dev-team', null)).hash as string;
  }

  async function change(
    overrides: Partial<WorkflowChange> = {},
  ): Promise<Record<string, unknown>> {
    return service.save({
      analysisRunId: 'analysis',
      slug: 'dev-team',
      workflow: FASTER,
      baseHash: await hash(),
      ids: ['W-1'],
      dryRun: false,
      ...overrides,
    });
  }

  it('backs the file up before saving, and the backup is never listed as a workflow', async () => {
    const before = await readFile(join(dir, 'dev-team.geniro.yaml'), 'utf8');

    const result = await change();

    expect(result).toMatchObject({ saved: true });
    expect(result.hash).toBe(await hash());
    const backups = await readdir(join(dir, WORKFLOW_BACKUP_DIR));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      /^dev-team\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.yaml$/,
    );
    expect(result.backup).toBe(`${WORKFLOW_BACKUP_DIR}/${backups[0]}`);
    expect(
      await readFile(join(dir, WORKFLOW_BACKUP_DIR, backups[0]!), 'utf8'),
    ).toBe(before);
    expect((await store.get('dev-team')).workflow.nodes[1]).toMatchObject({
      model: 'sonnet',
    });
    expect((await store.list()).map((entry) => entry.slug)).toEqual([
      'dev-team',
    ]);
  });

  it('refuses an id that is not in the latest Apply, even one an earlier Apply named', async () => {
    applies = [
      { cardSeq: 3, ids: ['W-1'] },
      { cardSeq: 3, ids: ['W-2'] },
    ];

    expect(await change({ ids: ['W-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_SELECTED',
    });
    applies = [];
    expect(await change()).toMatchObject({ error: 'NOT_APPLIED' });
  });

  it('refuses a repo item even when the user applied it', async () => {
    applies = [{ cardSeq: 3, ids: ['R-1'] }];

    expect(await change({ ids: ['R-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_A_WORKFLOW_ITEM',
    });
  });

  it('refuses a save on a copy that changed since it was read', async () => {
    const baseHash = await hash();
    await store.save('dev-team', { ...WF, description: 'edited by hand' });

    const result = await change({ baseHash });

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(result.currentHash).toBe(await hash());
  });

  it('refuses with HASH_DRIFT, keeping the other write, when the file changes while saving', async () => {
    const realSave = store.save.bind(store);
    let first = true;
    store.save = async (slug, workflow, baseHash) => {
      if (first) {
        first = false;
        // A builder autosave lands between the service's check and its write.
        await realSave(slug, { ...WF, description: 'builder autosave' });
      }
      return realSave(slug, workflow, baseHash);
    };

    const result = await change();

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(typeof result.backup).toBe('string');
    expect((await store.get('dev-team')).workflow.description).toBe(
      'builder autosave',
    );
  });

  it('refuses a workflow whose file was deleted, rather than re-creating it', async () => {
    const baseHash = await hash();
    await store.delete('dev-team');

    expect(await change({ baseHash })).toMatchObject({
      error: 'WORKFLOW_GONE',
    });
    await expect(readdir(dir)).resolves.not.toContain('dev-team.geniro.yaml');
  });

  it('refuses an invalid graph and writes nothing', async () => {
    const result = await change({
      workflow: {
        ...WF,
        edges: [...WF.edges, { from: 'reviewer', to: 'builder', kind: 'data' }],
      },
    });

    expect(result).toMatchObject({ saved: false, error: 'INVALID_WORKFLOW' });
    await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
  });

  it('answers the diff on a dry run and writes nothing', async () => {
    const result = await change({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      saved: false,
      diff: { changedNodes: [{ id: 'reviewer' }] },
    });
    expect((await store.get('dev-team')).workflow).toEqual(WF);
    await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
  });

  it("describes the library copy against the run's own snapshot", async () => {
    await writeFile(join(dir, 'unrelated.txt'), 'x');
    const described = await service.describe(
      'dev-team',
      workflowSnapshotOf(FASTER),
    );

    expect(described).toMatchObject({
      slug: 'dev-team',
      workflow: WF,
      changedSinceThisRun: { changedNodes: [{ id: 'reviewer' }] },
    });
    expect(typeof described.hash).toBe('string');
  });
});
