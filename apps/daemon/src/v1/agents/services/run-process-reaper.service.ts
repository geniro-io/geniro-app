import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { Injectable, Logger } from '@nestjs/common';

import {
  isSameProcess,
  readProcessStartTimes,
  type StartTimeProbe,
} from '../../../utils/process-identity';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import {
  parseScan,
  type ScannedProcess,
  selectRunProcesses,
} from '../utils/run-process-scan';

/** How long one `ps` listing may take before the scan gives up on it. */
const PS_TIMEOUT_MS = 4_000;

/** Test seams — the production factory passes nothing. */
export interface RunProcessReaperOptions {
  /** The joined process table, or null when it could not be read. */
  scan?: () => Promise<ScannedProcess[] | null>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  startTimes?: StartTimeProbe;
  wait?: (ms: number) => Promise<void>;
  logger?: { log(msg: string): void; warn(msg: string): void };
  selfPid?: number;
  uid?: number;
}

/**
 * Stop every process a run's agents left behind, once the run is archived or
 * deleted.
 *
 * Closing the run's sessions ends the agent CLIs, but not what they started
 * DETACHED to outlive a turn — `nohup pnpm dev`, a watcher, a headless browser.
 * Those are reparented to launchd and nothing the daemon holds still points at
 * them. What still does is their environment: every run-scoped CLI is spawned
 * with the run's tag (`RUN_ID_ENV`), and its descendants inherit it.
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
  private readonly scan: () => Promise<ScannedProcess[] | null>;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly startTimes: StartTimeProbe;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly selfPid: number;
  private readonly uid: number | null;

  constructor(options: RunProcessReaperOptions = {}) {
    this.logger = options.logger ?? new Logger(RunProcessReaper.name);
    this.scan = options.scan ?? scanProcessTable;
    this.signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
    this.startTimes = options.startTimes ?? readProcessStartTimes;
    this.wait = options.wait ?? ((ms) => sleep(ms));
    this.selfPid = options.selfPid ?? process.pid;
    this.uid = options.uid ?? process.getuid?.() ?? null;
  }

  /**
   * Reap in the background. A teardown route must not wait out the grace
   * period, and a failure here must not fail the archive or delete it follows.
   */
  reapInBackground(runId: string): void {
    void this.reap(runId).catch((err: unknown) => {
      this.logger.warn(
        `could not stop the processes of run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** SIGTERM, a grace period, then SIGKILL for survivors. Returns the pids signalled. */
  async reap(runId: string): Promise<number[]> {
    if (runId.trim() === '' || this.uid === null) {
      return [];
    }
    const rows = await this.scan();
    if (rows === null) {
      this.logger.warn(
        `could not read the process table — left run ${runId}'s processes alone`,
      );
      return [];
    }
    const { targets, overCap } = selectRunProcesses(rows, {
      runId,
      selfPid: this.selfPid,
      uid: this.uid,
    });
    if (overCap !== null) {
      this.logger.warn(
        `run ${runId} matched ${overCap.count} processes, more than a run can own — killed none. First of them: ${overCap.sample
          .map((row) => `${row.pid} (${row.args})`)
          .join(', ')}`,
      );
      return [];
    }
    const terminated = this.signalConfirmed(targets, 'SIGTERM', runId);
    if (terminated.length === 0) {
      return [];
    }
    await this.wait(GROUP_KILL_GRACE_MS);
    const killed = this.signalConfirmed(terminated, 'SIGKILL', runId);
    this.logger.log(
      `stopped ${terminated.length} process(es) of run ${runId}; ${killed.length} needed SIGKILL`,
    );
    return terminated.map((target) => target.pid);
  }

  /**
   * Signal each target still confirmed to be the process that was listed.
   * Those gone, or whose pid now belongs to something else, are skipped.
   */
  private signalConfirmed(
    targets: readonly ScannedProcess[],
    sig: NodeJS.Signals,
    runId: string,
  ): ScannedProcess[] {
    const alive = this.startTimes(targets.map((target) => target.pid));
    const signalled: ScannedProcess[] = [];
    for (const target of targets) {
      if (
        target.pid <= 1 ||
        target.startedAt === null ||
        !isSameProcess(target.pid, target.startedAt, alive)
      ) {
        continue;
      }
      try {
        this.signal(target.pid, sig);
      } catch {
        // It exited between the probe and the signal.
        continue;
      }
      signalled.push(target);
      this.logger.log(
        `${sig} pid ${target.pid} (${target.args}) of run ${runId}`,
      );
    }
    return signalled;
  }
}

/**
 * The process table with each row's environment. Two listings because `ps -E`
 * prints the environment glued to the arguments; the plain one is what tells
 * them apart (see `envSuffix`). Either failing reads as "unreadable", and an
 * unreadable table kills nothing.
 */
async function scanProcessTable(): Promise<ScannedProcess[] | null> {
  const [plain, withEnv] = await Promise.all([
    readPs(['-axww', '-o', 'pid=,ppid=,uid=,lstart=,args=']),
    readPs(['-axwwE', '-o', 'pid=,args=']),
  ]);
  return plain === null || withEnv === null ? null : parseScan(plain, withEnv);
}

function readPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      args,
      // Every process's whole environment: a few MB on a busy machine.
      { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, out) => resolve(error ? null : out),
    );
  });
}
