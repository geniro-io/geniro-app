import {
  type ChildProcess,
  execFileSync,
  spawn as nodeSpawn,
} from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import {
  DAEMON_INSPECT_PORT,
  type DaemonHandle,
  resolveDaemonInspect,
} from '../shared/contracts';
import {
  type DaemonInfo,
  isPlausiblePid,
  PIDFILE_NAME,
  readDaemonInfo,
  stampEntry,
} from './daemon-pidfile';
import { loginShellPath } from './login-shell-path';
import { readSettings } from './settings';

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
/** Per-attempt cap on the /health fetch — a wedged-but-listening daemon must
 * not stall start() on undici's multi-minute default. */
const HEALTH_FETCH_TIMEOUT_MS = 2_000;
const KILL_CONFIRM_MS = 1_000;
/**
 * Shutdown-timing invariant across the process boundary: UI grace > daemon
 * registry drain (SHUTDOWN_DRAIN_MS = 5s, apps/daemon …/services/process-registry.ts)
 * ≥ PTY group-SIGKILL escalation (KILL_ESCALATION_MS = 3s, …/services/pty.service.ts).
 * A grace below the drain SIGKILLs the daemon mid-drain, skipping pidfile
 * cleanup and orphaning SIGHUP-ignoring PTY groups.
 */
const SHUTDOWN_GRACE_MS = 7_000;
/**
 * How long a daemon WE spawned may sit with no client and no in-flight turn
 * before exiting itself (`GENIRO_IDLE_EXIT_MS`).
 *
 * It exists for the launches this supervisor can never clean up after: a
 * force-quit or a crash of the shell leaves the daemon running, `stop()` only
 * terminates the child it still owns, and a later launch adopts it rather than
 * replacing it. Ten minutes is chosen against BOTH failure modes — long enough
 * that quitting and reopening still adopts a warm daemon (and that a macOS
 * window closed with the app left in the Dock does not lose its backend under
 * the user), short enough that an abandoned one is measured in minutes rather
 * than the days that were actually observed.
 *
 * Only ever passed to a daemon we spawn: `pnpm daemon:dev` and the throwaway
 * daemon `pnpm generate:api` boots have no client by design.
 */
const DAEMON_IDLE_EXIT_MS = 600_000;

function pidfilePath(): string {
  return join(app.getPath('userData'), PIDFILE_NAME);
}

/**
 * Locate the built daemon entry. A packaged app ships the daemon as a
 * self-contained tree under Resources/daemon (see scripts/build-mac.mjs);
 * dev launches resolve the workspace dist relative to the bundled main
 * process.
 *
 * `dist/main.js` is produced by `pnpm build` alone, never by `electron-vite
 * dev` — so until turbo's `dev` task gained `dependsOn: ["^build"]`, launching
 * the app ran whatever compile happened to be lying here. Measured: source on
 * the latest `main`, `dist/main.js` from four days earlier, and a daemon
 * relaunched that morning still serving it. The `@geniro/daemon` dependency in
 * this app's package.json exists ONLY to give turbo that ordering edge — the
 * renderer imports nothing from it.
 */
function resolveDaemonEntry(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'daemon', 'dist', 'main.js'),
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'apps',
      'daemon',
      'dist',
      'main.js',
    ),
    join(app.getAppPath(), '..', '..', 'apps', 'daemon', 'dist', 'main.js'),
    join(process.cwd(), 'apps', 'daemon', 'dist', 'main.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      'daemon entry not found — build @geniro/daemon (pnpm build) first',
    );
  }
  return found;
}

/**
 * Version of the daemon we would spawn (its package.json sits one level above
 * dist/main.js in both the packaged Resources/daemon tree and the workspace).
 * Null when unreadable — the caller then skips the version gate rather than
 * killing a healthy daemon on a bad read.
 */
function bundledDaemonVersion(entry: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  // Mirror pidfile.ts: a non-positive/non-integer pid is never a real process
  // (process.kill(0,…) signals our own group, kill(-1,…) broadcasts).
  if (!isPlausiblePid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function defaultCheckHealth(
  host: string,
  port: number,
): Promise<boolean> {
  try {
    // /health/check is the @packages/http-server readiness endpoint (cloned
    // from Geniro), unauthenticated and version-neutral.
    const res = await fetch(`http://${host}:${port}/health/check`, {
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return false;
    }
    const body: unknown = await res.json();
    // status is @packages/http-server's HealthStatus.Ok — the literal 'Ok'.
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { status?: unknown }).status === 'Ok' &&
      typeof (body as { version?: unknown }).version === 'string'
    );
  } catch {
    return false;
  }
}

export async function defaultCheckIdentity(
  handle: DaemonHandle,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chats`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * How far a probed start time may sit from the recorded one and still count as
 * the same process. Mirrors the daemon's `PROCESS_IDENTITY_TOLERANCE_MS`:
 * `ps -o lstart` has one-second resolution, so this is rounding slack, not a
 * guess, and it is the only thing between a recycled pid and a SIGTERM aimed at
 * whatever now holds it.
 */
const PROCESS_IDENTITY_TOLERANCE_MS = 2_000;

/** Statuses a run is still doing something in. */
const LIVE_RUN_STATUSES = new Set(['pending', 'running']);

function hasLiveRun(body: unknown): boolean {
  return (
    Array.isArray(body) &&
    body.some(
      (run) =>
        typeof run === 'object' &&
        run !== null &&
        LIVE_RUN_STATUSES.has(String((run as { status?: unknown }).status)),
    )
  );
}

/**
 * Whether the daemon has a chat turn or a workflow run in flight.
 *
 * Both surfaces, because either one can hold live agent children and a
 * replacement kills them all. A non-ok response throws so the caller's
 * fail-toward-busy guard sees it, rather than reading an error body as "idle".
 */
export async function defaultCheckBusy(handle: DaemonHandle): Promise<boolean> {
  const read = async (path: string): Promise<unknown> => {
    const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`${path} answered ${res.status}`);
    }
    return res.json();
  };
  const [chats, workflowRuns] = await Promise.all([
    read('/v1/chats'),
    read('/v1/workflows/runs'),
  ]);
  return hasLiveRun(chats) || hasLiveRun(workflowRuns);
}

/** The kernel's start time for `pid` in epoch ms, or null if unreadable. */
export function defaultReadStartTime(pid: number): number | null {
  if (!isPlausiblePid(pid)) {
    return null;
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Date.parse(out.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    // Non-zero exit means the pid is gone, or `ps` refused. Either way this is
    // "cannot confirm", which the caller must not read as confirmation.
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHandle(info: DaemonInfo): DaemonHandle {
  return {
    host: info.host,
    port: info.port,
    token: info.token,
    version: info.version,
  };
}

/** Test seams, not user config — every slot defaults to the real implementation. */
export interface DaemonSupervisorOptions {
  spawn?: typeof nodeSpawn;
  readDaemonInfo?: (path: string) => DaemonInfo | null;
  isAlive?: (pid: number) => boolean;
  checkHealth?: (host: string, port: number) => Promise<boolean>;
  checkIdentity?: (handle: DaemonHandle) => Promise<boolean>;
  checkBusy?: (handle: DaemonHandle) => Promise<boolean>;
  readStartTime?: (pid: number) => number | null;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  resolveEntry?: () => string;
  bundledVersion?: (entry: string) => string | null;
  removePidfile?: (path: string) => void;
  pollIntervalMs?: number;
  shutdownGraceMs?: number;
}

/**
 * Spawns and supervises the loopback daemon child. Reuses a healthy daemon left
 * running by a prior UI instance (via the pidfile) ONLY when its version matches
 * the bundled daemon — after an auto-update, a leftover old daemon is torn down
 * and respawned so the shell and daemon can never skew. Sweeps orphaned
 * pidfiles, and tears down only the process it owns on quit.
 */
export class DaemonSupervisor {
  private child: ChildProcess | null = null;
  private owned = false;
  private handle: DaemonHandle | null = null;
  private currentPid: number | null = null;
  private startPromise: Promise<DaemonHandle> | null = null;
  private restartPromise: Promise<DaemonHandle> | null = null;
  private restartGeneration = 0;
  private stopping = false;

  private readonly spawn: typeof nodeSpawn;
  private readonly readInfo: (path: string) => DaemonInfo | null;
  private readonly isAlive: (pid: number) => boolean;
  private readonly checkHealth: (
    host: string,
    port: number,
  ) => Promise<boolean>;
  private readonly checkIdentity: (handle: DaemonHandle) => Promise<boolean>;
  private readonly checkBusy: (handle: DaemonHandle) => Promise<boolean>;
  private readonly readStartTime: (pid: number) => number | null;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly resolveEntry: () => string;
  private readonly bundledVersion: (entry: string) => string | null;
  private readonly removePidfile: (path: string) => void;
  private readonly pollIntervalMs: number;
  private readonly shutdownGraceMs: number;

  constructor(options: DaemonSupervisorOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.readInfo = options.readDaemonInfo ?? readDaemonInfo;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.checkHealth = options.checkHealth ?? defaultCheckHealth;
    this.checkIdentity = options.checkIdentity ?? defaultCheckIdentity;
    this.checkBusy = options.checkBusy ?? defaultCheckBusy;
    this.readStartTime = options.readStartTime ?? defaultReadStartTime;
    this.killPid =
      options.killPid ?? ((pid, signal) => process.kill(pid, signal));
    this.resolveEntry = options.resolveEntry ?? resolveDaemonEntry;
    this.bundledVersion = options.bundledVersion ?? bundledDaemonVersion;
    this.removePidfile =
      options.removePidfile ?? ((path) => rmSync(path, { force: true }));
    this.pollIntervalMs = options.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  /**
   * Whether a running daemon may be adopted, or is a stale build to replace.
   *
   * Named for what it DECIDES, not for what it proves: several inputs are
   * unidentifiable rather than current, and every one of them is adopted
   * anyway. Restarting a healthy daemon costs the user their in-flight turn,
   * so "cannot tell" resolves toward leaving it alone — deliberately, and only
   * where the alternative would be a kill on no evidence.
   *
   * `version` cannot make this call: it is the package version, unchanged
   * between rebuilds, so a rebuilt daemon was adopted over and the app went on
   * serving the previous compile. Measured here as a `pnpm dev` daemon four
   * days old, missing a module that had landed since, so a rebuild appeared to
   * change nothing and the instrumentation written to diagnose a bug never ran.
   * The stamp is mtime+size of the entry script: probe-verified that a turbo
   * CACHE HIT leaves both untouched (so an unchanged tree does not churn the
   * daemon), while any real build `rm -rf`s `dist/` and recompiles, moving
   * mtime even for a change that never reaches `main.js` itself.
   *
   * The adopt-anyway cases, each for its own reason:
   * - a DIFFERENT path — `pnpm daemon:dev` on TypeScript source, or a packaged
   *   daemon beside a dev one. A different thing, not an older one, and
   *   killing it would take down a developer's watch loop.
   * - an entry THIS process cannot stat — nothing to compare against.
   * - a recorded stamp that is unreadable on both sides, which would otherwise
   *   terminate and respawn a daemon that records the same unreadable stamp
   *   again, every launch, forever.
   *
   * A daemon that reported NO stamp is the one unidentifiable case that is
   * still replaced: only this app writes this pidfile, and the field has been
   * written since it existed, so its absence dates the daemon to before this
   * check — which is exactly the multi-day-stale daemon the check exists for,
   * running on the one launch where it is guaranteed to be there.
   */
  private mayAdopt(existing: DaemonInfo, entry: string): boolean {
    if (existing.entry === null) {
      return false;
    }
    const mine = stampEntry(entry, statSync);
    if (existing.entry.path !== mine.path) {
      return true;
    }
    if (mine.mtimeMs === null || existing.entry.mtimeMs === null) {
      return true;
    }
    return (
      existing.entry.mtimeMs === mine.mtimeMs &&
      existing.entry.size === mine.size
    );
  }

  /**
   * Whether a daemon this process does not own is in the middle of something.
   *
   * Replacing one tears down every agent child it registered, so an in-flight
   * turn dies without notice — in ANOTHER window, which is what makes it
   * unattributable to the user. That was tolerable while replacement happened
   * once per release; a rebuild now triggers it, and two windows plus a
   * `pnpm dev` is an ordinary afternoon.
   *
   * Errs toward BUSY. A daemon we cannot interrogate is one we must not kill:
   * adopting a stale daemon is recoverable by quitting and relaunching, while
   * a turn killed mid-flight is not recoverable at all.
   */
  private async isBusy(handle: DaemonHandle): Promise<boolean> {
    try {
      return (await this.checkBusy(handle)) !== false;
    } catch {
      return true;
    }
  }

  /**
   * Whether `pid` is still the process the pidfile describes.
   *
   * The daemon records its own start time, and this compares the kernel's. A
   * bare `kill(pid, 0)` cannot tell a recycled pid from the original — macOS
   * wraps them — and the next statement SIGTERMs it, so an unconfirmed identity
   * here means signalling a stranger: the user's own editor, their own
   * interactive `claude`.
   *
   * TWIN of the daemon's `utils/process-identity.ts`, which solves exactly this
   * for the child journal and the instance lock. The two apps share no code, so
   * the tolerance and the `ps` field must move together.
   *
   * Unconfirmable reads as NOT the same process, so the caller declines to
   * signal — the same direction that module takes, and for the same reason.
   */
  private confirmIdentity(existing: DaemonInfo): boolean {
    if (existing.pidStartedAtMs === null) {
      return true;
    }
    const actual = this.readStartTime(existing.pid);
    if (actual === null) {
      return false;
    }
    return (
      Math.abs(actual - existing.pidStartedAtMs) <=
      PROCESS_IDENTITY_TOLERANCE_MS
    );
  }

  start(): Promise<DaemonHandle> {
    if (this.stopping) {
      return Promise.reject(new Error('daemon supervisor is stopping'));
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const pending = this.startNow();
    this.startPromise = pending;
    const clear = (): void => {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async startNow(): Promise<DaemonHandle> {
    const entry = this.resolveEntry();
    const existing = this.readInfo(pidfilePath());
    if (existing && this.isAlive(existing.pid)) {
      const existingHandle = toHandle(existing);
      if (
        (await this.checkHealth(existing.host, existing.port)) &&
        (await this.checkIdentity(existingHandle))
      ) {
        const bundled = this.bundledVersion(entry);
        const versionMatches = bundled === null || existing.version === bundled;
        // Two gates stand between "this daemon is not the build I want" and
        // signalling it, and BOTH exist because replacement stopped being rare:
        // it used to fire only on a version bump, i.e. once per release, and now
        // fires on any rebuild. Each answers a question the staleness check
        // cannot: is anyone still using it, and is this pid even still it.
        const replaceable =
          !versionMatches || !this.mayAdopt(existing, entry)
            ? !(await this.isBusy(existingHandle)) &&
              this.confirmIdentity(existing)
            : false;
        if (!replaceable) {
          // Reuse a daemon another UI instance already started.
          this.owned = false;
          this.currentPid = existing.pid;
          this.handle = existingHandle;
          return this.handle;
        }
        await this.terminate(existing.pid);
      } else {
        throw new Error(
          `daemon pid ${existing.pid} is alive but failed identity/health verification; refusing to signal or start a second daemon`,
        );
      }
    }
    this.removePidfileBestEffort();
    if (this.stopping) {
      throw new Error('daemon supervisor stopped during startup');
    }
    return this.spawnDaemon(entry);
  }

  restart(): Promise<DaemonHandle> {
    if (this.stopping) {
      return Promise.reject(new Error('daemon supervisor is stopping'));
    }
    this.restartGeneration += 1;
    if (this.restartPromise) {
      return this.restartPromise;
    }
    const pending = this.restartUntilCurrent();
    this.restartPromise = pending;
    const clear = (): void => {
      if (this.restartPromise === pending) {
        this.restartPromise = null;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async restartUntilCurrent(): Promise<DaemonHandle> {
    let handle: DaemonHandle;
    do {
      const generation = this.restartGeneration;
      // Mirror stop(): let an in-flight start() settle before acting. A
      // restart overlapping startup would otherwise miss the mid-boot child
      // (no pid recorded yet), null it out, and orphan the booting daemon.
      if (this.startPromise) {
        await this.startPromise.catch(() => undefined);
      }
      handle = await this.restartNow();
      if (generation === this.restartGeneration) {
        return handle;
      }
    } while (!this.stopping);
    throw new Error('daemon supervisor stopped during restart');
  }

  private async restartNow(): Promise<DaemonHandle> {
    const pid = this.currentPid ?? this.readInfo(pidfilePath())?.pid ?? null;
    if (pid !== null && this.isAlive(pid)) {
      const current = this.handle;
      if (
        !current ||
        !(await this.checkHealth(current.host, current.port)) ||
        !(await this.checkIdentity(current))
      ) {
        throw new Error(
          `daemon pid ${pid} failed identity/health verification; refusing to signal it`,
        );
      }
      await this.terminate(pid);
    }
    this.owned = false;
    this.child = null;
    this.handle = null;
    this.currentPid = null;
    this.removePidfileBestEffort();
    if (this.stopping) {
      throw new Error('daemon supervisor stopped during restart');
    }
    return this.spawnDaemon(this.resolveEntry());
  }

  private removePidfileBestEffort(): void {
    try {
      this.removePidfile(pidfilePath());
    } catch {
      // best-effort
    }
  }

  /** SIGTERM (lets Nest shutdown hooks drain), SIGKILL past the grace. */
  private async terminate(pid: number): Promise<void> {
    try {
      this.killPid(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw err;
    }
    const deadline = Date.now() + this.shutdownGraceMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) {
        return;
      }
      await delay(this.pollIntervalMs);
    }
    try {
      this.killPid(pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw err;
      }
      return;
    }
    const killDeadline = Date.now() + KILL_CONFIRM_MS;
    while (Date.now() < killDeadline) {
      if (!this.isAlive(pid)) {
        return;
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error(`daemon pid ${pid} remained alive after SIGKILL`);
  }

  private async spawnDaemon(entry: string): Promise<DaemonHandle> {
    // No credential is sourced here any more. `cursor-agent` authenticates from
    // its own `~/.cursor` login, so geniro stores no Cursor key and has none to
    // hand over — the Keychain entry, this read, and the GENIRO_CURSOR_API_KEY
    // hop below it are all gone. A key the USER exported in their own shell
    // still reaches the daemon inside the `...process.env` spread below, and the
    // daemon's Cursor adapter re-injects it for its own child; nothing in this
    // process has to know about it.
    //
    // A packaged app launched from Finder inherits launchd's minimal PATH,
    // which is missing the user's CLI bin dirs — resolve the login-shell PATH
    // so the daemon can find `claude` / `cursor-agent`. Dev launches already
    // run from a terminal with the right PATH.
    const shellPath = app.isPackaged ? await loginShellPath() : null;
    if (this.stopping) {
      throw new Error('daemon supervisor stopped before daemon spawn');
    }
    // Settings cliPaths overrides ride the daemon env (GENIRO_-prefixed, so
    // they are stripped from every agent child); the daemon resolves them into
    // the spawn command for headless turns and for the handoff invocation it
    // hands back. A change in Settings applies on the next daemon spawn, like
    // the Cursor key.
    const settings = readSettings();
    const cliPaths = settings.cliPaths;
    const claudeBin = cliPaths['claude']?.trim();
    const cursorBin = cliPaths['cursor-agent']?.trim();
    // The daemon's inspector, when the user asked for one. It has to be an
    // argv flag ahead of the entry script — node reads it at process launch,
    // so there is no way to switch this on for a daemon already running, which
    // is why flipping the setting respawns.
    //
    // The host is spelled out rather than left to node's default: a bare
    // `--inspect=9229` binds 127.0.0.1 today, but the debugger port is the one
    // place in this app where "probably loopback" is not good enough, since
    // anything that reaches it runs arbitrary code inside the daemon.
    const inspectArgs = resolveDaemonInspect(
      settings.daemonInspect,
      app.isPackaged,
    )
      ? [`--inspect=127.0.0.1:${DAEMON_INSPECT_PORT}`]
      : [];
    const child = this.spawn(process.execPath, [...inspectArgs, entry], {
      env: {
        ...process.env,
        ...(shellPath ? { PATH: shellPath } : {}),
        // Run the daemon under Electron's bundled Node — no external runtime.
        ELECTRON_RUN_AS_NODE: '1',
        GENIRO_USER_DATA: app.getPath('userData'),
        // Self-shutdown window. Set HERE and nowhere else: it is the promise
        // that a UI is the only client, which is true exactly of the daemons
        // this supervisor spawns.
        GENIRO_IDLE_EXIT_MS: String(DAEMON_IDLE_EXIT_MS),
        ...(claudeBin ? { GENIRO_CLAUDE_BIN: claudeBin } : {}),
        ...(cursorBin ? { GENIRO_CURSOR_BIN: cursorBin } : {}),
        // No GENIRO_PORT: the daemon owns its default port and records the
        // actual bound host + port in the pidfile, which we read back below.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.owned = true;
    child.stdout?.on('data', (b: Buffer) =>
      process.stdout.write(`[daemon] ${b}`),
    );
    child.stderr?.on('data', (b: Buffer) =>
      process.stderr.write(`[daemon] ${b}`),
    );
    child.on('exit', () => {
      if (this.child === child) {
        this.handle = null;
        this.child = null;
        this.currentPid = null;
        this.owned = false;
      }
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping) {
        await this.stopChild(child);
        throw new Error('daemon supervisor stopped during daemon startup');
      }
      // Only adopt the pidfile OUR child wrote (pid match) — never a stale
      // descriptor that happens to still answer /health on another port.
      const info = this.readInfo(pidfilePath());
      if (
        info &&
        info.pid === child.pid &&
        (await this.checkHealth(info.host, info.port))
      ) {
        this.handle = toHandle(info);
        this.currentPid = info.pid;
        return this.handle;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `daemon exited during startup (code ${child.exitCode})`,
        );
      }
      await delay(this.pollIntervalMs);
    }
    await this.stopChild(child);
    if (this.child === child) {
      this.handle = null;
      this.child = null;
      this.currentPid = null;
      this.owned = false;
    }
    throw new Error('daemon did not become healthy within the timeout');
  }

  getHandle(): DaemonHandle | null {
    return this.handle;
  }

  isConnected(): boolean {
    return this.handle !== null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (this.restartPromise) {
      await this.restartPromise.catch(() => undefined);
    }
    const child = this.child;
    if (!this.owned || !child || child.exitCode !== null) {
      this.handle = null;
      this.currentPid = null;
      return;
    }
    await this.stopChild(child);
    this.handle = null;
    this.child = null;
    this.currentPid = null;
    this.owned = false;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) =>
        child.once('exit', () => resolve(true)),
      ),
      delay(this.shutdownGraceMs).then(() => false),
    ]);
    if (!exited) {
      child.kill('SIGKILL');
    }
  }
}
