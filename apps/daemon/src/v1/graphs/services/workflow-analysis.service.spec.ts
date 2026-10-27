import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import type { Workflow } from '../graphs.types';
import { WorkflowAnalysisService } from './workflow-analysis.service';
import { WorkflowStoreService } from './workflow-store.service';

const WF: Workflow = {
  name: 'Review Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};

describe('WorkflowAnalysisService', () => {
  let dir: string;
  let store: WorkflowStoreService;
  let analyses: {
    startWorkflow: ReturnType<typeof vi.fn>;
    findWorkflowAnalysis: ReturnType<typeof vi.fn>;
    deleteWorkflowAnalyses: ReturnType<typeof vi.fn>;
    analysedWorkflowSlugs: ReturnType<typeof vi.fn>;
  };
  let service: WorkflowAnalysisService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-workflow-analysis-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
    analyses = {
      startWorkflow: vi.fn().mockResolvedValue({ id: 'analysis' } as RunWire),
      findWorkflowAnalysis: vi.fn().mockResolvedValue(null),
      deleteWorkflowAnalyses: vi.fn().mockResolvedValue(undefined),
      analysedWorkflowSlugs: vi.fn().mockResolvedValue([]),
    };
    service = new WorkflowAnalysisService(
      store,
      analyses as unknown as ThreadAnalysisService,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts the analysis with the workflow’s name', async () => {
    const { slug } = await store.create(WF);

    await service.start(slug, { agentKind: 'claude', runs: 5 });

    expect(analyses.startWorkflow).toHaveBeenCalledWith(
      { slug, name: 'Review Team' },
      { agentKind: 'claude', runs: 5 },
    );
  });

  it('refuses a workflow the library does not hold, before touching any analysis', async () => {
    await expect(
      service.start('no-such-workflow', { agentKind: 'claude', runs: 5 }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.find('no-such-workflow')).rejects.toThrow(
      NotFoundException,
    );
    expect(analyses.startWorkflow).not.toHaveBeenCalled();
    expect(analyses.findWorkflowAnalysis).not.toHaveBeenCalled();
  });

  it('sweeps the analyses of workflows the library no longer holds, and only those', async () => {
    const { slug } = await store.create(WF);
    analyses.analysedWorkflowSlugs.mockResolvedValue([
      slug,
      'deleted-team',
      '../not-a-slug',
    ]);

    await service.sweepOrphans();

    expect(analyses.deleteWorkflowAnalyses.mock.calls).toEqual([
      ['deleted-team'],
      ['../not-a-slug'],
    ]);
  });
});
