import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Injectable, Logger } from '@nestjs/common';

import {
  isSameProcess,
  parseStartTimes,
} from '../../../utils/process-identity';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import { capSelection, type ScannedProcess } from '../utils/run-process-scan';
import { runPs } from '../utils/run-ps';
import type { RunProcessAttribution } from './run-process-attribution.service';

/** Seams — the production factory passes `held`; specs pass the rest. */
export interface RunProcessReaperOptions {
  /**
   * Whether the registry holds a live agent process under the run right now.
   * Such a run was reopened after its reap was queued, and its processes are
   * a working agent's, not leftovers.
   */
  held?: (runId: string) => boolean;
  /**
   * Which of these runs are still deleted or archived. Asked after the scan
   * for a reap the SWEEP queued, whose verdict may be minutes old — never for
   * an archive or delete, which the user has just made.
   */
  stillGone?: (runIds: string[]) => Promise<ReadonlySet<string>>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Start times (epoch ms) of whichever of `pids` are alive. */
  startTimes?: (pids: number[]) => Promise<Map<number, number>>;
  wait?: (ms: number) => Promise<void>;
  logger?: { log(msg: string): void; warn(msg: string): void };
  selfPid?: number;
}

/** One process about to be signalled, and the run it is stopped for. */
interface Target {
  row: ScannedProcess;
  runId: string;
}

/**
 * Whether a pid may never be signalled, whatever selected it: launchd, the
 * whole-session `-1`, and the daemon itself.
 */
export function isUnsignallable(pid: number, selfPid: number): boolean {
  return pid <= 1 || pid === selfPid;
}

/**
 * Stop every process a run's agents left behind, once the run is archived or
 * deleted — or, through the sweep, once it turns out to be gone.
 *
 * Closing the run's sessions ends the agent CLIs, but not what they started
 * DETACHED to outlive a turn — `nohup pnpm dev`, a watcher, a headless browser.
 * Those are reparented to launchd and nothing the daemon holds still points at
 * them. What still does is their environment: every run-scoped CLI is spawned
 * with the run's tag, and its descendants inherit it (`attributeRunProcesses`).
 *
 * Signals go to explicit pids only — never a process group, never a pattern —
 * and each pid is confirmed to be the process that was listed (its kernel
 * start time) before either signal reaches it. Anything that cannot be
 * confirmed is left alone: a surviving dev server costs memory, a wrong kill
 * costs the user their session.
 */
@Injectable()
export class RunProcessReaper {
  private readonly logger: NonNullable<RunProcessReaperOptions['logger']>;
  private readonly held: (runId: string) => boolean;
  private readonly stillGone: (
    runIds: string[],
  ) => Promise<ReadonlySet<string>>;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly startTimes: (pids: number[]) => Promise<Map<number, number>>;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly selfPid: number;
  /**
   * Runs waiting for the next reap, each with whether it is reaped only if
   * still gone; one reap runs at a time, over one scan.
   */
  private readonly queued = new Map<string, boolean>();
  private draining: Promise<void> | null = null;

  constructor(
    private readonly attribution: RunProcessAttribution,
    options: RunProcessReaperOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(RunProcessReaper.name);
    this.held = options.held ?? (() => false);
    this.stillGone =
      options.stillGone ?? ((runIds) => Promise.resolve(new Set(runIds)));
    this.signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
    this.startTimes = options.startTimes ?? readStartTimes;
    this.wait = options.wait ?? ((ms) => sleep(ms));
    this.selfPid = options.selfPid ?? process.pid;
  }

  /**
   * Reap in the background. A teardown route must not wait out the grace
   * period, and a failure here must not fail the archive or delete it follows.
   *
   * Queued rather than started: a retention sweep deletes runs one after
   * another, and a full `ps -E` per run, all at once, is megabytes each. What
   * queued while a reap ran is reaped together, over one scan.
   */
  reapInBackground(runId: string, onlyIfStillGone = false): void {
    if (runId.trim() === '') {
      return;
    }
    // An unconditional request wins: an archive is not undone by a sweep's
    // stale verdict queued beside it.
    this.queued.set(runId, onlyIfStillGone && (this.queued.get(runId) ?? true));
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Resolves once every queued reap has finished. For the sweep and specs. */
  async settled(): Promise<void> {
    while (this.draining !== null) {
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
    while (this.queued.size > 0) {
      const runIds = [...this.queued.keys()];
      const conditional = new Set(
        [...this.queued].filter(([, onlyIf]) => onlyIf).map(([id]) => id),
      );
      this.queued.clear();
      try {
        await this.reap(runIds, conditional);
      } catch (err: unknown) {
        this.logger.warn(
          `could not stop the processes of run(s) ${runIds.join(', ')}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** SIGTERM, a grace period, then SIGKILL for survivors. Returns the pids signalled. */
  async reap(
    runIds: readonly string[],
    onlyIfStillGone: ReadonlySet<string> = new Set(),
  ): Promise<number[]> {
    const wanted = runIds.filter((runId) => runId.trim() !== '');
    if (wanted.length === 0) {
      return [];
    }
    const reading = await this.attribution.attribute('fresh');
    if (reading === null) {
      this.logger.warn(
        `could not read the process table — left the processes of run(s) ${wanted.join(', ')} alone`,
      );
      return [];
    }
    const gone =
      onlyIfStillGone.size === 0
        ? new Set<string>()
        : await this.stillGone([...onlyIfStillGone]);
    const targets: Target[] = [];
    for (const runId of wanted) {
      if (onlyIfStillGone.has(runId) && !gone.has(runId)) {
        this.logger.log(
          `run ${runId} is back in use — left its processes alone`,
        );
        continue;
      }
      // Asked AFTER the scan: whatever the registry holds by now was spawned
      // before the table was read, so it is in it — and is not ours to end.
      if (this.held(runId)) {
        this.logger.log(
          `run ${runId} has a live agent again — left its processes alone`,
        );
        continue;
      }
      const { targets: selected, overCap } = capSelection(
        reading.get(runId) ?? [],
      );
      if (overCap !== null) {
        this.logger.warn(
          `run ${runId} matched ${overCap.count} processes, more than a run can own — killed none. First of them: ${overCap.sample
            .map((row) => `${row.pid} (${nameOf(row)})`)
            .join(', ')}`,
        );
        continue;
      }
      targets.push(...selected.map((row) => ({ row, runId })));
    }
    const terminated = await this.signalConfirmed(targets, 'SIGTERM');
    if (terminated.length === 0) {
      return [];
    }
    await this.wait(GROUP_KILL_GRACE_MS);
    const killed = await this.signalConfirmed(terminated, 'SIGKILL');
    this.logger.log(
      `stopped ${terminated.length} process(es) of run(s) ${wanted.join(', ')}; ${killed.length} needed SIGKILL`,
    );
    return terminated.map((target) => target.row.pid);
  }

  /**
   * Signal each target still confirmed to be the process that was listed.
   * Those gone, or whose pid now belongs to something else, are skipped.
   */
  private async signalConfirmed(
    targets: readonly Target[],
    sig: NodeJS.Signals,
  ): Promise<Target[]> {
    if (targets.length === 0) {
      return [];
    }
    const alive = await this.startTimes(targets.map(({ row }) => row.pid));
    const signalled: Target[] = [];
    for (const target of targets) {
      const { row, runId } = target;
      if (
        isUnsignallable(row.pid, this.selfPid) ||
        row.startedAt === null ||
        !isSameProcess(row.pid, row.startedAt, alive)
      ) {
        continue;
      }
      try {
        this.signal(row.pid, sig);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.logger.warn(
            `could not send ${sig} to pid ${row.pid} (${nameOf(row)}) of run ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        continue;
      }
      signalled.push(target);
      // The executable only: an argv can carry a credential, and this line
      // reaches the debug log a user attaches to a bug report.
      this.logger.log(`${sig} pid ${row.pid} (${nameOf(row)}) of run ${runId}`);
    }
    return signalled;
  }
}

function nameOf(row: ScannedProcess): string {
  return basename(row.args.split(/\s+/)[0] ?? '') || '?';
}

/**
 * Start times from one asynchronous listing of the whole table. The per-pid
 * probe in `process-identity` is synchronous and falls back to one `ps` per pid
 * when none of them is alive — the normal case after a SIGTERM — which would
 * stall the daemon for every run it serves.
 */
async function readStartTimes(pids: number[]): Promise<Map<number, number>> {
  const out = await runPs(['-axww', '-o', 'pid=,lstart=']);
  if (out === null) {
    return new Map();
  }
  const wanted = new Set(pids);
  return new Map([...parseStartTimes(out)].filter(([pid]) => wanted.has(pid)));
}
