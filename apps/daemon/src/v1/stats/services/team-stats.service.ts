import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type {
  ChatTotalsWire,
  RecommendationsTeamPopulation,
} from '../../agents/chat.types';
import { GoalDao } from '../../agents/dao/goal.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import type { Team } from '../../teams/teams.types';
import { teamOfCanonical } from '../../teams/utils/team-version';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type {
  HistoryRecommendationStatus,
  MemberAssessmentEntryWire,
  MemberAssessmentRow,
  TeamStatsWire,
  TeamVersionsWire,
  ThreadLedgerRow,
} from '../stats.types';
import { foldMemberChanges } from '../utils/member-change-fold';
import {
  assessmentsByMember,
  foldMemberWork,
  memberRunCells,
} from '../utils/member-work-fold';
import { recommendationStatusOf } from '../utils/team-history-fold';
import {
  foldTeamPopulation,
  foldTeamStats,
  withWallTimes,
} from '../utils/team-stats-fold';
import { totalsByRun } from '../utils/team-versions-fold';
import { foldThreadMetrics } from '../utils/thread-metrics-fold';
import { TeamVersionsService } from './team-versions.service';

/** A team's recorded versions as numbered by the versions table. */
interface VersionNumbers {
  ref: (version: string) => { number: number | null; current: boolean };
}

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
    private readonly versionDao: TeamVersionDao,
    private readonly changeLog: TeamChangeLogService,
  ) {}

  async read(slug: string): Promise<TeamStatsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const adapters = this.adapters.all();
    const polledKinds = [...adapters.keys()].filter((kind) =>
      pollsSpendFor(adapters, kind),
    );
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
    const wallTurns = await this.wallTurns.turnsOfRuns(runIds, em);
    const timed = withWallTimes(usage, wallTurns);
    const teams = await this.teamsOf(slug, em);
    const numbers = await this.versionNumbers(slug);
    const cells = memberRunCells({
      threads,
      usage: timed,
      toolCalls,
      calls,
      stages,
      goals,
      stageOwners: stageOwnersOf(teams, threads),
    });
    const rows = await this.assessments.rowsOf(slug, em);
    const figures = foldTeamStats({
      slug,
      threads,
      usage,
      wallTurns,
      polledKinds,
      outcomes: await this.activityDao.runOutcomes({ teamSlug: slug }, em),
      memberWork: foldMemberWork(cells),
      changes: foldMemberChanges({
        threads,
        cells,
        teamSpend: totalsByRun(timed, polledKinds),
        teams,
        versionRef: numbers.ref,
        changeLog: await this.changeLog.entriesOf(slug),
      }),
      assessments: await this.assessmentsOf(
        slug,
        rows,
        threads,
        teams,
        numbers,
        em,
      ),
    });
    return {
      ...figures,
      assessmentVerdicts: {
        assessments: rows.length,
        agreed: rows.filter((row) => row.userVerdict?.verdict === 'agree')
          .length,
        disagreed: rows.filter((row) => row.userVerdict?.verdict === 'disagree')
          .length,
      },
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

  /** Every run the team has, measured over every ledger row, whichever few an analysis read. */
  async population(slug: string): Promise<RecommendationsTeamPopulation> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    return foldTeamPopulation(
      threads,
      await this.totalsOf(
        threads.map((thread) => thread.runId),
        em,
      ),
    );
  }

  /** What each of these runs cost and did, over every row its ledgers hold. */
  async totalsOf(
    runIds: readonly string[],
    em: EntityManager = this.em.fork(),
  ): Promise<Map<string, ChatTotalsWire>> {
    const adapters = this.adapters.all();
    return totalsByRun(
      withWallTimes(
        await this.usageDao.rowsByRuns(runIds, em),
        await this.wallTurns.turnsOfRuns(runIds, em),
      ),
      [...adapters.keys()].filter((kind) => pollsSpendFor(adapters, kind)),
    );
  }

  /** Every recorded version's team, by version. */
  private async teamsOf(
    slug: string,
    em: EntityManager,
  ): Promise<Map<string, Team>> {
    const teams = new Map<string, Team>();
    for (const recorded of await this.versionDao.graphsOf(slug, em)) {
      const team = teamOfCanonical(recorded.graph);
      if (team !== null) {
        teams.set(recorded.version, team);
      }
    }
    return teams;
  }

  private async versionNumbers(slug: string): Promise<VersionNumbers> {
    const table = await this.versionTable(slug);
    const numbers = new Map<string, number>();
    for (const row of table?.versions ?? []) {
      if (row.version !== null && row.ordinal !== null) {
        numbers.set(row.version, row.ordinal);
      }
    }
    return {
      ref: (version) => ({
        number: numbers.get(version) ?? null,
        current: version === table?.currentVersion,
      }),
    };
  }

  private async assessmentsOf(
    slug: string,
    rows: readonly MemberAssessmentRow[],
    threads: readonly ThreadLedgerRow[],
    teams: ReadonlyMap<string, Team>,
    numbers: VersionNumbers,
    em: EntityManager,
  ): Promise<Map<string, MemberAssessmentEntryWire[]>> {
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
    const threadOf = new Map(threads.map((thread) => [thread.runId, thread]));
    const versionsOf = (runIds: readonly string[]) =>
      [
        ...new Set(
          runIds.flatMap((runId) => {
            const version = threadOf.get(runId)?.version;
            return version == null ? [] : [version];
          }),
        ),
      ]
        .map(numbers.ref)
        .sort(
          (a, b) =>
            (a.number ?? Number.MAX_SAFE_INTEGER) -
            (b.number ?? Number.MAX_SAFE_INTEGER),
        );
    const adapters = [...this.adapters.all()];
    const vendorOf = (agent: string, model: string | null): string | null =>
      adapters.find(([kind]) => kind === agent)?.[1].modelVendorOf(model) ??
      null;
    const sameVendorOf = (row: MemberAssessmentRow): boolean | null => {
      const newest = row.runIds
        .flatMap((runId) => {
          const thread = threadOf.get(runId);
          return thread === undefined || thread.version === null
            ? []
            : [thread];
        })
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
      const member = (
        newest?.version == null ? undefined : teams.get(newest.version)
      )?.members.find((entry) => entry.id === row.memberId);
      const judge =
        row.judge.agent === null
          ? null
          : vendorOf(row.judge.agent, row.judge.model);
      const own =
        member === undefined
          ? null
          : vendorOf(member.agent, member.model ?? null);
      return judge === null || own === null ? null : judge === own;
    };
    return assessmentsByMember(rows, statusOf, versionsOf, sameVendorOf);
  }

  /** The versions table, or null when it cannot be read — versions are then named without a number. */
  private async versionTable(slug: string): Promise<TeamVersionsWire | null> {
    try {
      return await this.versions.read(slug);
    } catch (err) {
      this.logger.warn(
        `team ${slug}'s versions could not be read for its members: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/** Who is responsible for each stage in the team version each run ran. */
function stageOwnersOf(
  teams: ReadonlyMap<string, Team>,
  threads: readonly ThreadLedgerRow[],
): (runId: string, stageId: string) => readonly string[] {
  const ownersByVersion = new Map<string, Map<string, string[]>>();
  for (const [version, team] of teams) {
    ownersByVersion.set(
      version,
      new Map(
        (team.stages ?? []).map((stage) => [
          stage.id,
          [...new Set(stage.responsible ?? [])],
        ]),
      ),
    );
  }
  const versionOfRun = new Map(
    threads.map((thread) => [thread.runId, thread.version]),
  );
  return (runId, stageId) => {
    const version = versionOfRun.get(runId);
    return version == null
      ? []
      : (ownersByVersion.get(version)?.get(stageId) ?? []);
  };
}
