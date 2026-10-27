import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { workflowVersionOf } from '../../graphs/utils/workflow-version';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import type { WorkflowVersionsWire } from '../stats.types';
import { foldWorkflowVersions } from '../utils/workflow-versions-fold';

/**
 * One workflow's runs by graph version, for the Workflows screen. Every read is batched
 * over the workflow's run ids, and the figures come from one pure fold
 * (`foldWorkflowVersions`) over the rows as read.
 */
@Injectable()
export class WorkflowVersionsService {
  constructor(
    private readonly em: EntityManager,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly versionDao: WorkflowVersionDao,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly store: WorkflowStoreService,
  ) {}

  async read(slug: string): Promise<WorkflowVersionsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const runIds = threads.map((thread) => thread.runId);
    const live = new Map(
      (await this.runDao.runFacts(runIds, em)).map((run) => [run.id, run]),
    );
    const liveFailedNodes = new Map<string, string[]>();
    for (const node of await this.nodeStateDao.failedByRuns(
      [...live.keys()],
      em,
    )) {
      liveFailedNodes.set(node.runId, [
        ...(liveFailedNodes.get(node.runId) ?? []),
        node.nodeId,
      ]);
    }
    const adapters = this.adapters.all();
    return foldWorkflowVersions({
      slug,
      currentVersion: await this.currentVersion(slug),
      threads,
      live,
      usage: await this.usageDao.rowsByRuns(runIds, em),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      liveFailedNodes,
      graphs: await this.versionDao.graphsOf(slug, em),
    });
  }

  /** The library graph's version, or null when the file is gone or no longer reads. */
  private async currentVersion(slug: string): Promise<string | null> {
    try {
      return workflowVersionOf((await this.store.get(slug)).workflow);
    } catch {
      return null;
    }
  }
}
