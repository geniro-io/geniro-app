import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import {
  backUpTeam,
  readTeamSource,
  sameBackupOf,
} from '../../teams/utils/team-backup';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
  edgeIdentity,
  teamOfCanonical,
  teamVersionOf,
} from '../../teams/utils/team-version';
import { parseTeamYaml } from '../../teams/utils/team-yaml';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type {
  TeamVersionGraph,
  TeamVersionRestoredWire,
  TeamVersionsWire,
  VersionChangesWire,
} from '../stats.types';
import { foldTeamVersions } from '../utils/team-versions-fold';
import { versionDiff } from '../utils/version-diff';

/** Diffs kept in memory; past it the cache starts over. */
const DIFF_CACHE_LIMIT = 500;

/**
 * One team's runs by graph version, for the Teams screen. Every read is batched
 * over the team's run ids, and the figures come from one pure fold
 * (`foldTeamVersions`) over the rows as read.
 */
@Injectable()
export class TeamVersionsService {
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
    private readonly versionDao: TeamVersionDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly store: TeamStoreService,
    private readonly changeLog: TeamChangeLogService,
  ) {}

  async read(slug: string): Promise<TeamVersionsWire> {
    const em = this.em.fork();
    const threads = await this.activityDao.threadRowsBySlug(slug, em);
    const adapters = this.adapters.all();
    const graphs = await this.versionDao.graphsOf(slug, em);
    const current = await this.currentGraph(slug);
    return foldTeamVersions({
      slug,
      currentVersion: current?.version ?? null,
      unrecorded:
        current !== null &&
        !graphs.some((graph) => graph.version === current.version)
          ? current
          : null,
      threads,
      usage: await this.usageDao.rowsByRuns(
        threads.map((thread) => thread.runId),
        em,
      ),
      polledKinds: [...adapters.keys()].filter((kind) =>
        pollsSpendFor(adapters, kind),
      ),
      graphs,
      changesOf: (previous, next) => this.changesOf(slug, previous, next),
    });
  }

  /**
   * Write a recorded version back as the team's graph: its nodes, edges, stages and
   * active-turn cap. The team keeps its own name and description, the canvas places of
   * the nodes it still has, and the labels of the edges it still has — none of them is part
   * of a version. The file as it stood is backed up first (`.backups/`, as an applied change
   * does), and the write quotes the hash it was read at, so a save landing in between is
   * refused rather than overwritten. A version is restorable only while its graph is
   * recorded: an inferred one never was.
   *
   * The graph being replaced is recorded too when no run has stamped it (an edit not run
   * yet), numbered as of now, so the table keeps it and it can be restored back. One a
   * run has stamped already has its row: recorded, or inferred and kept unnumbered.
   */
  async restore(
    slug: string,
    version: string,
    baseHash: string | undefined,
  ): Promise<TeamVersionRestoredWire> {
    const graphs = await this.versionDao.graphsOf(slug, this.em.fork());
    const recorded = graphs.find((graph) => graph.version === version);
    if (recorded === undefined) {
      throw new NotFoundException(
        'TEAM_VERSION_NOT_FOUND',
        `Version ${version} of '${slug}' has no recorded graph`,
      );
    }
    const graph = teamOfCanonical(recorded.graph);
    if (graph === null) {
      throw new BadRequestException(
        'TEAM_VERSION_UNREADABLE',
        `Version ${version} of '${slug}' no longer reads as a team`,
      );
    }
    const { path, directory } = this.store.locate(slug);
    const current = await readTeamSource(path);
    if (current === null) {
      throw new NotFoundException(
        'TEAM_NOT_FOUND',
        `No team '${slug}' in the library`,
      );
    }
    if (baseHash !== undefined && baseHash !== current.hash) {
      throw new ConflictException(
        'TEAM_CHANGED',
        `Team '${slug}' changed since this copy was read — reload it before restoring`,
      );
    }
    const backup =
      (await sameBackupOf(directory, slug, current.source)) ??
      (await backUpTeam(directory, slug, current.source));
    const replaced = parseTeamYaml(current.source);
    const replacedVersion = teamVersionOf(replaced);
    const em = this.em.fork();
    if (
      replacedVersion !== version &&
      !(await this.activityDao.threadRowsBySlug(slug, em)).some(
        (thread) => thread.version === replacedVersion,
      )
    ) {
      await this.versionDao.register(
        slug,
        replacedVersion,
        canonicalGraphJson(canonicalGraphOf(replaced)),
        new Date(),
        em,
      );
    }
    const saved = await this.store.save(
      slug,
      restoredTeam(graph, replaced),
      current.hash,
    );
    await this.changeLog.record({
      slug,
      source: 'restore',
      before: replaced,
      after: saved.team,
      summary: `Restored version ${graphs.indexOf(recorded) + 1} (${version})`,
      backup,
    });
    return {
      slug,
      version: teamVersionOf(saved.team),
      hash: saved.hash,
      backup,
    };
  }

  private changesOf(
    slug: string,
    previous: TeamVersionGraph,
    next: TeamVersionGraph,
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

  /** The library's graph and its version, or null when the file is gone or no longer reads. */
  private async currentGraph(slug: string): Promise<TeamVersionGraph | null> {
    try {
      const { team } = await this.store.get(slug);
      return {
        version: teamVersionOf(team),
        graph: canonicalGraphJson(canonicalGraphOf(team)),
        firstSeenAt: new Date(),
      };
    } catch {
      return null;
    }
  }
}

/** `graph`'s nodes, edges, cap and stages under `current`'s name, description, places and labels. */
function restoredTeam(graph: Team, current: Team): Team {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const labels = new Map(
    current.edges.flatMap((edge) =>
      edge.label === undefined ? [] : [[edgeIdentity(edge), edge.label]],
    ),
  );
  const layout = Object.fromEntries(
    Object.entries(current.layout ?? {}).filter(([id]) => ids.has(id)),
  );
  return {
    name: current.name,
    ...(current.description === undefined
      ? {}
      : { description: current.description }),
    ...(graph.maxActiveTurns === undefined
      ? {}
      : { maxActiveTurns: graph.maxActiveTurns }),
    nodes: graph.nodes,
    edges: graph.edges.map((edge) => {
      const label = labels.get(edgeIdentity(edge));
      return label === undefined ? edge : { ...edge, label };
    }),
    ...(Object.keys(layout).length === 0 ? {} : { layout }),
    ...(graph.stages === undefined ? {} : { stages: graph.stages }),
  };
}
