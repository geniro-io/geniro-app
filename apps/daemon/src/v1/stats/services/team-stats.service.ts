import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { GoalDao } from '../../agents/dao/goal.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type {
  HistoryRecommendationStatus,
  MemberAssessmentEntryWire,
  TeamStatsWire,
  TeamVersionsWire,
} from '../stats.types';
import { assessmentsByMember, foldMemberWork } from '../utils/member-work-fold';
import { recommendationStatusOf } from '../utils/team-history-fold';
import { foldTeamStats } from '../utils/team-stats-fold';
import { foldThreadMetrics } from '../utils/thread-metrics-fold';
import { TeamVersionsService } from './team-versions.service';

/**
 * One team's runs, spend, outcomes, members and thread metrics, read from the ledgers alone so
 * runs and chats that are gone still count. Every figure is folded over every
 * row of every run stamped with the team (`foldTeamStats`), never a page of them.
 */
@Injectable()
export class TeamStatsService {
  private readonly logger = new Logger(TeamStatsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly ledger: MetricLedgerDao,
    private readonly goals: GoalDao,
    private readonly wallTurns: WallTurnDao,
    private readonly assessments: MemberAssessmentDao,
    private readonly recommendations: TeamRecommendationDao,
    private readonly runDao: RunDao,
    private readonly versions: TeamVersionsService,
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
    const usage = await this.usageDao.rowsByRuns(runIds, em);
    const figures = foldTeamStats({
      slug,
      threads,
      usage,
      wallTurns: await this.wallTurns.turnsOfRuns(runIds, em),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      outcomes: await this.activityDao.runOutcomes({ teamSlug: slug }, em),
      memberWork: foldMemberWork({
        threads,
        turns: usage,
        toolCalls,
        calls,
        stages,
        goals,
      }),
      assessments: await this.assessmentsOf(slug, em),
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

  private async assessmentsOf(
    slug: string,
    em: EntityManager,
  ): Promise<Map<string, MemberAssessmentEntryWire[]>> {
    const rows = await this.assessments.rowsOf(slug, em);
    if (rows.length === 0) {
      return new Map();
    }
    const filed = await this.recommendations.rowsOf(slug, em);
    const cardKey = (chatRunId: string, cardSeq: number): string =>
      JSON.stringify([chatRunId, cardSeq]);
    const items = new Map(
      filed.map((row) => [
        JSON.stringify([row.chatRunId, row.cardSeq, row.itemId]),
        row,
      ]),
    );
    const appliedCards = new Set(
      filed.flatMap((row) =>
        row.selectedAt === null ? [] : [cardKey(row.chatRunId, row.cardSeq)],
      ),
    );
    const liveChats = new Set<string>();
    for (const chatRunId of new Set(filed.map((row) => row.chatRunId))) {
      if ((await this.runDao.getById(chatRunId, em)) !== null) {
        liveChats.add(chatRunId);
      }
    }
    const statusOf = (
      chatRunId: string,
      cardSeq: number,
      itemId: string,
    ): HistoryRecommendationStatus | null => {
      const row = items.get(JSON.stringify([chatRunId, cardSeq, itemId]));
      return row === undefined
        ? null
        : recommendationStatusOf(
            row,
            liveChats.has(chatRunId),
            appliedCards.has(cardKey(chatRunId, cardSeq)),
          );
    };
    const table = await this.versionTable(slug);
    const numbers = new Map<string, number>();
    for (const row of table?.versions ?? []) {
      if (row.version !== null && row.ordinal !== null) {
        numbers.set(row.version, row.ordinal);
      }
    }
    return assessmentsByMember(rows, statusOf, (version) =>
      version === null
        ? null
        : {
            number: numbers.get(version) ?? null,
            current: version === table?.currentVersion,
          },
    );
  }

  /** The versions table, or null when it cannot be read — assessments are then named without a number. */
  private async versionTable(slug: string): Promise<TeamVersionsWire | null> {
    try {
      return await this.versions.read(slug);
    } catch (err) {
      this.logger.warn(
        `team ${slug}'s versions could not be read for its member assessments: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
