import { homedir } from 'node:os';
import { basename } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type {
  RecommendationsTeamPopulation,
  TeamVersionIndex,
} from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { nearestProjectOf } from '../../projects/utils/nearest-project';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { TeamHistory, TeamOtherRun, TeamSpend } from '../stats.types';
import { foldTeamHistory } from '../utils/team-history-fold';
import { foldTeamSpend, type SpendPlace } from '../utils/team-spend-fold';
import { totalsByRun } from '../utils/team-versions-fold';
import { TeamStatsService } from './team-stats.service';
import { TeamVersionsService } from './team-versions.service';

/**
 * A team's history for its analysis: its versions and what their runs
 * did, the writes logged against it, the recommendations filed about it, and
 * each member's work and the earlier analyses' marks of it.
 * Read from the ledgers, which outlive the runs and chats they record, so an
 * analysis sees past the runs it was started on and past the analyses it
 * replaced.
 */
@Injectable()
export class TeamHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly versions: TeamVersionsService,
    private readonly activityDao: UsageActivityDao,
    private readonly usageDao: UsageEventDao,
    private readonly recommendations: TeamRecommendationDao,
    private readonly changeLog: TeamChangeLogService,
    private readonly runDao: RunDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly stats: TeamStatsService,
    private readonly projectRoots: ProjectRootsService,
    private readonly projects: ProjectDao,
  ) {}

  /** Each recorded version's number, and the library's version now. */
  async versionIndex(slug: string): Promise<TeamVersionIndex> {
    const table = await this.versions.read(slug);
    const numbers = new Map<string, number>();
    for (const row of table.versions) {
      if (row.version !== null && row.ordinal !== null) {
        numbers.set(row.version, row.ordinal);
      }
    }
    return { current: table.currentVersion, numbers };
  }

  /**
   * Where a team's money went, over every run its ledgers hold whatever the
   * analysis samples. Filed by the folder a turn ran in, as Stats' By project
   * files it, since a deleted run has no project of its own to ask.
   */
  async spend(
    slug: string,
    scope: { analysedRunIds: readonly string[] },
  ): Promise<TeamSpend> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const rows = await this.usageDao.rowsByRuns(
      threads.map((thread) => thread.runId),
      em,
    );
    const roots = await this.projectRoots.rootsOf(rows.map((row) => row.cwd));
    const refs = await this.projects.listRefs(em);
    const home = homedir();
    const places = new Map<string, SpendPlace>();
    const adapters = this.adapters.all();
    return foldTeamSpend({
      slug,
      threads,
      rows,
      analysedRunIds: scope.analysedRunIds,
      now: new Date(),
      ratesOf: (agentKind, model) =>
        agentKind === null
          ? null
          : (adapters.get(agentKind)?.billingRatesOf(model) ?? null),
      placeOf: (cwd) => {
        if (cwd === null) {
          return { key: '', project: null, folder: null };
        }
        const known = places.get(cwd);
        if (known !== undefined) {
          return known;
        }
        const folder = roots.get(cwd) ?? cwd;
        const project = nearestProjectOf(folder, refs, home);
        const place: SpendPlace =
          project === null
            ? { key: folder, project: null, folder: basename(folder) }
            : { key: project.id, project: project.name, folder: null };
        places.set(cwd, place);
        return place;
      },
    });
  }

  population(slug: string): Promise<RecommendationsTeamPopulation> {
    return this.stats.population(slug);
  }

  /**
   * Every run of the team outside what the analysis samples, newest first, for
   * the analysis to open one by id. A deleted run has no rows to open, so it is
   * not listed here; view=spend and view=history still count it.
   */
  async otherRuns(
    slug: string,
    scope: { analysedRunIds: readonly string[] },
  ): Promise<TeamOtherRun[]> {
    const em = this.em.fork();
    const sampled = new Set(scope.analysedRunIds);
    const runs = (await this.runDao.newestTeamRuns(slug, null, em)).filter(
      (run) => !sampled.has(run.id),
    );
    const totals = await this.stats.totalsOf(
      runs.map((run) => run.id),
      em,
    );
    return runs.map((run) => ({
      runId: run.id,
      title: run.title,
      createdAt: run.createdAt.toISOString(),
      statusNow: run.status,
      archived: run.archivedAt !== null,
      costUsd: totals.get(run.id)?.costUsd ?? null,
    }));
  }

  async read(
    slug: string,
    scope: { analysedRunIds: readonly string[]; readerRunId: string | null },
  ): Promise<TeamHistory> {
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
    const { byMember } = await this.stats.read(slug);
    return foldTeamHistory({
      slug,
      versions: await this.versions.read(slug),
      threads,
      totals: totalsByRun(
        await this.usageDao.rowsByRuns(runIds, em),
        [...adapters.keys()].filter((kind) => pollsSpendFor(adapters, kind)),
      ),
      outcomes: await this.activityDao.runOutcomes({ teamSlug: slug }, em),
      changeLog: await this.changeLog.entriesWithOverlaysOf(slug),
      recommendations,
      liveChats,
      analysedRunIds: scope.analysedRunIds,
      readerRunId: scope.readerRunId,
      members: byMember,
    });
  }
}
