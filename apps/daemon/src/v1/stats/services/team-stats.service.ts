import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { TeamStatsWire } from '../stats.types';
import { foldTeamStats } from '../utils/team-stats-fold';

/**
 * One team's runs, spend, outcomes and members, read from the ledgers alone so
 * runs and chats that are gone still count. Every figure is folded over every
 * row of every run stamped with the team (`foldTeamStats`), never a page of them.
 */
@Injectable()
export class TeamStatsService {
  constructor(
    private readonly em: EntityManager,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  async read(slug: string): Promise<TeamStatsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const adapters = this.adapters.all();
    return foldTeamStats({
      slug,
      threads,
      usage: await this.usageDao.rowsByRuns(
        threads.map((thread) => thread.runId),
        em,
      ),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      outcomes: await this.activityDao.runOutcomes({ teamSlug: slug }, em),
    });
  }
}
