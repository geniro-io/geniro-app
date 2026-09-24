import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';
import type { Workflow } from '../graphs.types';
import { workflowSnapshotOf } from '../utils/workflow-snapshot';
import { RunWorkflowService } from './run-workflow.service';
import type { WorkflowStoreService } from './workflow-store.service';

// Schema-VALID on purpose: a copy the schema cannot read is treated as no copy
// at all, so an invalid fixture would pass the "reads the library" cases while
// never exercising the snapshot it claims to.
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

  it('re-freezes a copy the current schema cannot read, rather than running a broken graph', async () => {
    const { service, updates } = doubles(graph('library today'), null);
    const run = {
      id: 'run-2',
      workflowId: 'dev-team',
      workflowSnapshot: '{"not":"a workflow"}',
    };

    const workflow = await service.workflowOf(run);

    expect(workflow.nodes).toHaveLength(2);
    expect(updates).toHaveLength(1);
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
