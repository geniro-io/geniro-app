import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { sleepWatch } from '../../../utils/sleep-watch';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { runIdOfSessionKey } from '../utils/session-keys';
import { AgentSessionRegistry } from './agent-session.registry';
import { RunIdleReapService } from './run-idle-reap.service';
import { RunProcessAttribution } from './run-process-attribution.service';
import { RunProcessReaper } from './run-process-reaper.service';

/** How long after boot the first sweep runs — the boot itself is busy enough. */
export const RUN_PROCESS_SWEEP_FIRST_MS = 15_000;

/** How often the table is swept after that. */
export const RUN_PROCESS_SWEEP_EVERY_MS = 5 * 60_000;

/** Test seam — the production factory passes nothing. */
export interface RunProcessSweepOptions {
  logger?: { log(msg: string): void; warn(msg: string): void };
}

/**
 * Stop what threads that no longer exist, or are archived, still have running
 * — and what live threads that sat unused for the kept-session window do.
 *
 * Archive and delete reap their own run, but that reap can miss: the app quit
 * during its grace period, a run was deleted while the daemon was down, a
 * launcher started a child between the scan and the signal, or the reap found
 * the table unreadable. Without this, those processes would sit adopted by
 * launchd for as long as the machine is up — the case this whole mechanism
 * exists to end. The usage readout lists them as leftover until a sweep has.
 *
 * A gone or archived run is swept only when THIS geniro's database says so
 * (the owner tag keeps another geniro's runs, which this database has never
 * heard of, out of it entirely), and no run while the registry still holds a
 * process under it. A database that cannot be read sweeps nothing.
 *
 * A live run is swept once its newest transcript row — the end of its last
 * turn, its last message, anything its agents wrote between turns — is older
 * than the idle window ({@link RunIdleReapService}). The registry's idle close
 * covers a run whose CLI it keeps; this covers one it does not: after a daemon
 * restart, or an eviction. Counted, like the idle close, from the last wake as
 * well — time asleep is not a run going unused — and only once the user's
 * window has been pushed, since the default may be shorter than theirs.
 */
@Injectable()
export class RunProcessSweep
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger: NonNullable<RunProcessSweepOptions['logger']>;
  private timers: NodeJS.Timeout[] = [];
  private running: Promise<string[]> | null = null;
  /** When the machine last woke, as the sleep watch saw it; 0 before any. */
  private wokeAt = 0;
  private stopWatching: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly reaper: RunProcessReaper,
    private readonly attribution: RunProcessAttribution,
    private readonly idleReap: RunIdleReapService,
    options: RunProcessSweepOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(RunProcessSweep.name);
  }

  onApplicationBootstrap(): void {
    this.stopWatching = sleepWatch.subscribe(() => {
      this.wokeAt = Date.now();
    });
    const first = setTimeout(
      () => this.sweepInBackground(),
      RUN_PROCESS_SWEEP_FIRST_MS,
    );
    const every = setInterval(
      () => this.sweepInBackground(),
      RUN_PROCESS_SWEEP_EVERY_MS,
    );
    // Never the reason the daemon stays alive.
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  onApplicationShutdown(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers = [];
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private sweepInBackground(): void {
    void this.sweep().catch((err: unknown) => {
      this.logger.warn(
        `could not sweep leftover processes: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * One sweep: the runs whose leftovers it handed to the reaper, once the
   * reaper is done with them. A sweep still running is joined, not doubled.
   */
  sweep(): Promise<string[]> {
    this.running ??= this.sweepOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweepOnce(): Promise<string[]> {
    // Candidates only: the reaper takes its own fresh scan before any signal.
    const reading = await this.attribution.attribute('readout');
    if (reading === null) {
      this.logger.warn('could not read the process table — swept nothing');
      return [];
    }
    const held = new Set(
      this.sessions.processRoots().map((root) => runIdOfSessionKey(root.key)),
    );
    const candidates = [...reading.keys()].filter((runId) => !held.has(runId));
    if (candidates.length === 0) {
      return [];
    }
    const live = new Set(
      (
        await this.runDao.getAll(
          { id: { $in: candidates }, archivedAt: null },
          undefined,
          this.em.fork(),
        )
      ).map((run) => run.id),
    );
    const gone = candidates.filter((runId) => !live.has(runId));
    const idle = await this.idleOf(
      [...live].filter((runId) => !this.idleReap.awaitingGrace(runId)),
    );
    const listed = (runIds: string[]): string =>
      runIds
        .map((runId) => `${runId} (${reading.get(runId)?.length ?? 0})`)
        .join(', ');
    if (gone.length > 0) {
      this.logger.log(
        `stopping what ${gone.length} deleted or archived thread(s) left running: ${listed(gone)}`,
      );
    }
    if (idle.length > 0) {
      this.logger.log(
        `stopping what ${idle.length} thread(s) unused for the idle window left running: ${listed(idle)}`,
      );
    }
    gone.forEach((runId) => this.reaper.reapInBackground(runId, true));
    await Promise.all([
      this.reaper.settled(),
      ...idle.map((runId) => this.idleReap.reap(runId)),
    ]);
    return [...gone, ...idle];
  }

  /** Of these live runs, the ones whose newest row is older than the idle window. */
  private async idleOf(runIds: string[]): Promise<string[]> {
    // A wake this sweep's own timer fired at is seen here before the ticker.
    sleepWatch.check();
    const since = Date.now() - this.sessions.idleMinutes * 60_000;
    if (
      runIds.length === 0 ||
      !this.sessions.hasUserIdleWindow ||
      this.wokeAt >= since
    ) {
      return [];
    }
    const latest = await this.itemDao.latestItemAtPerRun(
      runIds,
      this.em.fork(),
    );
    // A run with no row has nothing to date its last use by.
    return runIds.filter((runId) => {
      const at = latest.get(runId);
      return at !== undefined && at.getTime() < since;
    });
  }
}
