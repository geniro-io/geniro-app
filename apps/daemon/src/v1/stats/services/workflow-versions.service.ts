import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import {
  canonicalGraphYaml,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import type {
  VersionChangesWire,
  WorkflowVersionGraph,
  WorkflowVersionsWire,
} from '../stats.types';
import { versionDiff } from '../utils/version-diff';
import { foldWorkflowVersions } from '../utils/workflow-versions-fold';

/** Diffs kept in memory; past it the cache starts over. */
const DIFF_CACHE_LIMIT = 500;

/**
 * One workflow's runs by graph version, for the Workflows screen. Every read is batched
 * over the workflow's run ids, and the figures come from one pure fold
 * (`foldWorkflowVersions`) over the rows as read.
 */
@Injectable()
export class WorkflowVersionsService {
  /**
   * Diffs between two versions, by slug and both versions. A version is the hash of its
   * graph, so a pair's diff never changes, and the table is re-read after every recorded
   * turn: without this each re-read would diff every version again.
   */
  private readonly diffs = new Map<string, VersionChangesWire | null>();

  constructor(
    private readonly em: EntityManager,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly versionDao: WorkflowVersionDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly store: WorkflowStoreService,
  ) {}

  async read(slug: string): Promise<WorkflowVersionsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const adapters = this.adapters.all();
    return foldWorkflowVersions({
      slug,
      currentVersion: await this.currentVersion(slug),
      threads,
      usage: await this.usageDao.rowsByRuns(
        threads.map((thread) => thread.runId),
        em,
      ),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      graphs: await this.versionDao.graphsOf(slug, em),
      changesOf: (previous, next) => this.changesOf(slug, previous, next),
    });
  }

  private changesOf(
    slug: string,
    previous: WorkflowVersionGraph,
    next: WorkflowVersionGraph,
  ): VersionChangesWire | null {
    const key = JSON.stringify([slug, previous.version, next.version]);
    const cached = this.diffs.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const before = canonicalGraphYaml(previous.graph);
    const after = canonicalGraphYaml(next.graph);
    const changes =
      before === null || after === null
        ? null
        : versionDiff(slug, before, after);
    if (this.diffs.size >= DIFF_CACHE_LIMIT) {
      this.diffs.clear();
    }
    this.diffs.set(key, changes);
    return changes;
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
