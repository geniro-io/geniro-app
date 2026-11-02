import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { GoalDao } from '../../agents/dao/goal.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { TeamStatsWire } from '../stats.types';
import { foldTeamStats } from '../utils/team-stats-fold';
import { foldThreadMetrics } from '../utils/thread-metrics-fold';

/**
 * One team's runs, spend, outcomes, members and thread metrics, read from the ledgers alone so
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
    private readonly ledger: MetricLedgerDao,
    private readonly goals: GoalDao,
    private readonly wallTurns: WallTurnDao,
  ) {}

  async read(slug: string): Promise<TeamStatsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const adapters = this.adapters.all();
    const scope = { teamSlug: slug };
    const [goals, threadOutcomes, toolCalls, stages, calls] = await Promise.all(
      [
        this.goals.statusesOf(scope, em),
        this.ledger.threadOutcomes(scope, em),
        this.ledger.toolCalls(scope, em),
        this.ledger.stages(scope, em),
        this.ledger.calls(scope, em),
      ],
    );
    const runIds = threads.map((thread) => thread.runId);
    const figures = foldTeamStats({
      slug,
      threads,
      usage: await this.usageDao.rowsByRuns(runIds, em),
      wallTurns: await this.wallTurns.turnsOfRuns(runIds, em),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      outcomes: await this.activityDao.runOutcomes({ teamSlug: slug }, em),
    });
    return {
      ...figures,
      metrics: foldThreadMetrics({
        runs: threads,
        goals,
        threadOutcomes,
        toolCalls,
        stages,
        calls,
      }),
    };
  }
}
