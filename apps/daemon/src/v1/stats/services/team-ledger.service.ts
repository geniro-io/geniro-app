import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { RunFacts } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import {
  parseTeamSnapshot,
  snapshotCanonicalJson,
  snapshotVersionOf,
} from '../../teams/utils/team-snapshot';
import { isLegacyCanonical } from '../../teams/utils/team-version';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';

/**
 * Runs created before this instant got no team copy when they started; theirs was
 * frozen from the library on a later read, so their version is marked inferred. It is
 * the release that started keeping copies (v1.93.0, 2026-09-13), so on an install
 * updated later a run made in between is not marked, though its copy is as late.
 */
export const SNAPSHOT_AT_CREATION_SINCE = new Date('2026-09-14T00:00:00.000Z');

/** Runs the boot sweep stamps between yields to the event loop. */
const SWEEP_WINDOW = 25;

/**
 * The team ledger: stamps each team run's `usage_activity` thread row with its
 * team version when it is created, and records each version's team in
 * `team_versions`. Both survive the run's deletion, which is what lets the Teams
 * screen count a version's runs and cost after its chats are gone.
 *
 * It observes the bus like `UsageActivityRecorderService`. Work for one run is queued, so
 * a run announced twice is stamped once at a time; different runs do not wait on each
 * other.
 */
@Injectable()
export class TeamLedgerService implements OnModuleInit {
  private readonly logger = new Logger(TeamLedgerService.name);
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly activityDao: UsageActivityDao,
    private readonly versionDao: TeamVersionDao,
    private readonly changeLog: TeamChangeLogService,
  ) {}

  onModuleInit(): void {
    this.bus.allRunCreated().subscribe((event) => {
      void this.enqueue(event.runId, (em) =>
        this.recordVersion(event.runId, em),
      );
    });
  }

  /** Resolves once every stamp queued so far has been written (or logged as failed). */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /**
   * Stamp every team run that has no version stamp yet: a run from before the ledger,
   * or one whose announce was missed. Awaited at boot BEFORE the server listens, so
   * nothing can delete a run before it is stamped; a second call finds nothing to do.
   */
  async sweep(): Promise<{ versions: number }> {
    const em = this.em.fork();
    const runs = await this.runDao.runFacts('every-team-run', em);
    const rows = await this.activityDao.threadRowsByRuns(
      runs.map((run) => run.id),
      em,
    );
    const unversioned = runs.filter((run) => {
      const row = rows.get(run.id);
      return row === undefined || row.slug === null;
    });
    let versions = 0;
    for (let at = 0; at < unversioned.length; at += SWEEP_WINDOW) {
      const window = unversioned.slice(at, at + SWEEP_WINDOW);
      const snapshots = await this.runDao.teamSnapshots(
        window.map((run) => run.id),
        em,
      );
      for (const run of window) {
        if (
          await this.guarded(run.id, () =>
            this.stampVersion(run, snapshots.get(run.id) ?? null, em),
          )
        ) {
          versions += 1;
        }
      }
      await yieldToEventLoop();
    }
    if (versions > 0) {
      this.logger.log(`team ledger: stamped ${versions} version(s)`);
    }
    return { versions };
  }

  private enqueue(
    runId: string,
    work: (em: EntityManager) => Promise<void>,
  ): Promise<void> {
    const tail: Promise<void> = (this.queues.get(runId) ?? Promise.resolve())
      .then(() => this.guarded(runId, () => work(this.em.fork())))
      .then(() => {
        if (this.queues.get(runId) === tail) {
          this.queues.delete(runId);
        }
      });
    this.queues.set(runId, tail);
    return tail;
  }

  private async recordVersion(runId: string, em: EntityManager): Promise<void> {
    const [run] = await this.runDao.runFacts([runId], em);
    if (run === undefined || run.teamId === null) {
      return;
    }
    const snapshots = await this.runDao.teamSnapshots([runId], em);
    await this.stampVersion(run, snapshots.get(runId) ?? null, em);
  }

  /**
   * Stamp a run's team and version, once. A run with no team copy it can read is
   * stamped with its team alone and stays that way, even when a later read freezes
   * the library's team into it: that team is not the one it ran.
   *
   * An inferred version is not registered. Its team was frozen at some later, unknown
   * time, so its run's creation date says nothing about when that version was first used,
   * and registering it would number it, and diff its neighbours, out of order.
   */
  private async stampVersion(
    run: RunFacts,
    snapshot: string | null,
    em: EntityManager,
  ): Promise<void> {
    if (run.teamId === null) {
      return;
    }
    const reading = parseTeamSnapshot(snapshot);
    if (reading.state !== 'readable') {
      await this.activityDao.stampThreadVersion(
        run.id,
        run.createdAt,
        { slug: run.teamId, version: null, inferred: null },
        em,
      );
      return;
    }
    const version = snapshotVersionOf(reading);
    const inferred =
      run.createdAt.getTime() < SNAPSHOT_AT_CREATION_SINCE.getTime();
    if (!inferred && reading.legacy === null) {
      await this.noteMigration(run.teamId, version, em);
    }
    if (!inferred) {
      // The team first, so a stamped version always has its team to show.
      await this.versionDao.register(
        run.teamId,
        version,
        snapshotCanonicalJson(reading),
        run.createdAt,
        em,
      );
    }
    await this.activityDao.stampThreadVersion(
      run.id,
      run.createdAt,
      { slug: run.teamId, version, inferred },
      em,
    );
  }

  /**
   * Logs the team's conversion from a node graph once, at the first team-shaped
   * version recorded after only graph-shaped ones.
   */
  private async noteMigration(
    slug: string,
    version: string,
    em: EntityManager,
  ): Promise<void> {
    const recorded = await this.versionDao.graphsOf(slug, em);
    const latest = recorded.at(-1);
    if (
      latest === undefined ||
      latest.version === version ||
      recorded.some((entry) => !isLegacyCanonical(entry.graph))
    ) {
      return;
    }
    await this.changeLog.recordMigration(slug, latest.version, version);
  }

  /**
   * Runs one stamp, logging a failure instead of throwing it into the bus or the sweep.
   * True when it wrote.
   */
  private async guarded(
    runId: string,
    stamp: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await stamp();
      return true;
    } catch (err) {
      this.logger.warn(
        `could not stamp the version of team run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
