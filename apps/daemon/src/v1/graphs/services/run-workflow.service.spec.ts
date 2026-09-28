import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';
import type { Workflow } from '../graphs.types';
import { workflowSnapshotOf } from '../utils/workflow-snapshot';
import { RunWorkflowService } from './run-workflow.service';
import type { WorkflowStoreService } from './workflow-store.service';

// Schema-VALID on purpose: a copy the schema cannot read is REFUSED (see the
// cases below), so an invalid fixture would fail the "reads its own copy"
// cases for a reason that has nothing to do with them.
const graph = (role: string): Workflow => ({
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'engineer',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      role,
    },
  ],
  edges: [{ from: 'start', to: 'engineer', kind: 'data' }],
});

function doubles(library: Workflow, stored: Partial<Run> | null) {
  const updates: { id: string; data: Partial<Run> }[] = [];
  const runDao = {
    getById: vi.fn(async () => stored),
    updateWithoutActivity: vi.fn(async (id: string, data: Partial<Run>) => {
      updates.push({ id, data });
      return 1;
    }),
  } as unknown as RunDao;
  const get = vi.fn(async (slug: string) => ({ slug, workflow: library }));
  const store = { get } as unknown as WorkflowStoreService;
  const em = { fork: () => ({}) } as unknown as EntityManager;
  return { service: new RunWorkflowService(em, runDao, store), updates, get };
}

describe('RunWorkflowService', () => {
  it('answers with the run’s OWN copy, whatever the library now says', async () => {
    // The reported defect: editing the workflow changed every run made from it.
    const { service, get } = doubles(graph('edited since'), null);
    const run = {
      id: 'run-1',
      workflowId: 'dev-team',
      workflowSnapshot: workflowSnapshotOf(graph('as it started')),
    };

    const workflow = await service.workflowOf(run);

    expect(workflow.nodes.find((node) => node.id === 'engineer')).toMatchObject(
      { role: 'as it started' },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('FREEZES a run that kept no copy on its first read, and reads the library once', async () => {
    const { service, updates, get } = doubles(graph('library today'), null);
    const run: Pick<Run, 'id' | 'workflowSnapshot'> & { workflowId: string } = {
      id: 'run-old',
      workflowId: 'dev-team',
      workflowSnapshot: null,
    };

    const first = await service.workflowOf(run);
    expect(first.nodes.find((node) => node.id === 'engineer')).toMatchObject({
      role: 'library today',
    });
    expect(updates).toEqual([
      {
        id: 'run-old',
        data: { workflowSnapshot: workflowSnapshotOf(graph('library today')) },
      },
    ]);
    // The object it was handed carries the copy now, so a later read of the
    // same run is served from it even after the library changes.
    expect(run.workflowSnapshot).not.toBeNull();
    get.mockResolvedValue({
      slug: 'dev-team',
      workflow: graph('edited later'),
    });
    const second = await service.workflowOf(run);
    expect(second.nodes.find((node) => node.id === 'engineer')).toMatchObject({
      role: 'library today',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  /**
   * An unreadable copy is still the graph the run STARTED with. It used to be
   * read as "no copy yet" and overwritten with the library's current workflow,
   * so the run went on under its old name running whatever the library holds
   * today — and the only record of what it did run was destroyed doing it.
   */
  describe('a copy the current schema cannot read', () => {
    it.each([
      ['a shape this build does not know', '{"not":"a workflow"}'],
      ['text that is not JSON at all', '{"name": "Dev Team", "nodes": ['],
    ])(
      '%s is refused, never replaced from the library',
      async (_label, raw) => {
        const { service, updates, get } = doubles(graph('library today'), null);
        const run = {
          id: 'run-2',
          workflowId: 'dev-team',
          workflowSnapshot: raw,
        };

        await expect(service.workflowOf(run)).rejects.toMatchObject({
          errorCode: 'WORKFLOW_SNAPSHOT_UNREADABLE',
        });

        expect(updates).toEqual([]);
        expect(get).not.toHaveBeenCalled();
        expect(run.workflowSnapshot).toBe(raw);
      },
    );

    it('says which run and what could not be read', async () => {
      const { service } = doubles(graph('library today'), null);

      await expect(
        service.workflowOf({
          id: 'run-2',
          workflowId: 'dev-team',
          workflowSnapshot: '{"not":"a workflow"}',
        }),
      ).rejects.toThrow(/run-2.*cannot be read/);
    });
  });

  it('serves the route from the run row, and refuses a chat run', async () => {
    const workflowRun = {
      id: 'run-3',
      workflowId: 'dev-team',
      workflowSnapshot: workflowSnapshotOf(graph('kept')),
    } as Run;
    const { service } = doubles(graph('library'), workflowRun);
    await expect(service.snapshotOfRun('run-3')).resolves.toMatchObject({
      workflow: { name: 'Dev Team' },
    });

    const chat = { id: 'chat-1', workflowId: null } as Run;
    const { service: forChat } = doubles(graph('library'), chat);
    await expect(forChat.snapshotOfRun('chat-1')).rejects.toThrow();
  });
});
