import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { CapturedPullRequest } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { UsageActivityDao } from '../dao/usage-activity.dao';

/**
 * Writes what threads did into the `usage_activity` ledger as the agent plane announces
 * it: a run's creation, and each pull request a thread opened. The ledger outlives the
 * thread, so the Stats page can still count a thread that was later deleted.
 *
 * It OBSERVES the bus rather than being called. The agents module publishes these facts
 * and cannot depend on this module, which imports it.
 */
@Injectable()
export class UsageActivityRecorderService implements OnModuleInit {
  private readonly logger = new Logger(UsageActivityRecorderService.name);

  constructor(
    private readonly bus: AgentEventBus,
    private readonly activityDao: UsageActivityDao,
  ) {}

  onModuleInit(): void {
    this.bus.allRunCreated().subscribe((event) => {
      void this.recordThread(event.runId, event.createdAt);
    });
    this.bus.allPullRequestsCaptured().subscribe((event) => {
      void this.recordPullRequests(event.runId, event.pullRequests);
    });
  }

  private async recordThread(runId: string, createdAt: string): Promise<void> {
    try {
      await this.activityDao.insertThreadOnce(runId, new Date(createdAt));
    } catch (err) {
      this.logger.warn(
        `could not record thread ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async recordPullRequests(
    runId: string,
    pullRequests: readonly CapturedPullRequest[],
  ): Promise<void> {
    for (const pullRequest of pullRequests) {
      try {
        await this.activityDao.insertPullRequestOnce({
          runId,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          number: pullRequest.number,
          url: pullRequest.url,
          occurredAt: new Date(pullRequest.occurredAt),
        });
      } catch (err) {
        this.logger.warn(
          `could not record pull request ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} for thread ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
