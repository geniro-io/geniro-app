import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { WorkflowVersionIndex } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { WorkflowChangeLogService } from '../../graphs/services/workflow-change-log.service';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { WorkflowRecommendationDao } from '../dao/workflow-recommendation.dao';
import type { WorkflowHistory } from '../stats.types';
import { foldWorkflowHistory } from '../utils/workflow-history-fold';
import { totalsByRun } from '../utils/workflow-versions-fold';
import { WorkflowVersionsService } from './workflow-versions.service';

/**
 * A workflow's history for its analysis: its versions and what their runs
 * did, the writes logged against it, and the recommendations filed about it.
 * Read from the ledgers, which outlive the runs and chats they record, so an
 * analysis sees past the runs it was started on and past the analyses it
 * replaced.
 */
@Injectable()
export class WorkflowHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly versions: WorkflowVersionsService,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly recommendations: WorkflowRecommendationDao,
    private readonly changeLog: WorkflowChangeLogService,
    private readonly runDao: RunDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /** Each recorded version's number, and the library's version now. */
  async versionIndex(slug: string): Promise<WorkflowVersionIndex> {
    const table = await this.versions.read(slug);
    const numbers = new Map<string, number>();
    for (const row of table.versions) {
      if (row.version !== null && row.ordinal !== null) {
        numbers.set(row.version, row.ordinal);
      }
    }
    return { current: table.currentVersion, numbers };
  }

  async read(
    slug: string,
    scope: { analysedRunIds: readonly string[]; readerRunId: string | null },
  ): Promise<WorkflowHistory> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const runIds = threads.map((thread) => thread.runId);
    const adapters = this.adapters.all();
    const recommendations = await this.recommendations.rowsOf(slug, em);
    const liveChats = new Set<string>();
    for (const chatRunId of new Set(
      recommendations.map((row) => row.chatRunId),
    )) {
      if ((await this.runDao.getById(chatRunId, em)) !== null) {
        liveChats.add(chatRunId);
      }
    }
    return foldWorkflowHistory({
      slug,
      versions: await this.versions.read(slug),
      threads,
      totals: totalsByRun(
        await this.usageDao.rowsByRuns(runIds, em),
        [...adapters.keys()].filter((kind) => pollsSpendFor(adapters, kind)),
      ),
      outcomes: await this.activityDao.runOutcomes({ workflowSlug: slug }, em),
      changeLog: await this.changeLog.entriesOf(slug),
      recommendations,
      liveChats,
      analysedRunIds: scope.analysedRunIds,
      readerRunId: scope.readerRunId,
    });
  }
}
