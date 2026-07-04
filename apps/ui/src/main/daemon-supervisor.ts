import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { type DaemonHandle } from '../shared/contracts';
import {
  type DaemonInfo,
  isPlausiblePid,
  PIDFILE_NAME,
  readDaemonInfo,
} from './daemon-pidfile';
import { getSecret } from './keychain';
import { loginShellPath } from './login-shell-path';
import { readSettings } from './settings';

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
/** Per-attempt cap on the /health fetch — a wedged-but-listening daemon must
 * not stall start() on undici's multi-minute default. */
const HEALTH_FETCH_TIMEOUT_MS = 2_000;
/**
 * Shutdown-timing invariant across the process boundary: UI grace > daemon
 * registry drain (SHUTDOWN_DRAIN_MS = 5s, apps/daemon …/services/process-registry.ts)
 * ≥ PTY group-SIGKILL escalation (KILL_ESCALATION_MS = 3s, …/services/pty.service.ts).
 * A grace below the drain SIGKILLs the daemon mid-drain, skipping pidfile
 * cleanup and orphaning SIGHUP-ignoring PTY groups.
 */
const SHUTDOWN_GRACE_MS = 7_000;

function pidfilePath(): string {
  return join(app.getPath('userData'), PIDFILE_NAME);
}

/**
 * Locate the built daemon entry. A packaged app ships the daemon as a
 * self-contained tree under Resources/daemon (see scripts/build-mac.mjs);
 * dev launches resolve the workspace dist relative to the bundled main
 * process. Building @geniro/daemon is a dev prerequisite (turbo orders it).
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

async function defaultCheckHealth(
  host: string,
  port: number,
): Promise<boolean> {
  try {
    // /health/check is the @packages/http-server readiness endpoint (cloned
    // from Geniro), unauthenticated and version-neutral.
    const res = await fetch(`http://${host}:${port}/health/check`, {
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
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

  private readonly spawn: typeof nodeSpawn;
  private readonly readInfo: (path: string) => DaemonInfo | null;
  private readonly isAlive: (pid: number) => boolean;
  private readonly checkHealth: (
    host: string,
    port: number,
  ) => Promise<boolean>;
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
    this.killPid =
      options.killPid ?? ((pid, signal) => process.kill(pid, signal));
    this.resolveEntry = options.resolveEntry ?? resolveDaemonEntry;
    this.bundledVersion = options.bundledVersion ?? bundledDaemonVersion;
    this.removePidfile =
      options.removePidfile ?? ((path) => rmSync(path, { force: true }));
    this.pollIntervalMs = options.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  async start(): Promise<DaemonHandle> {
    const entry = this.resolveEntry();
    const existing = this.readInfo(pidfilePath());
    if (
      existing &&
      this.isAlive(existing.pid) &&
      (await this.checkHealth(existing.host, existing.port))
    ) {
      const bundled = this.bundledVersion(entry);
      if (bundled === null || existing.version === bundled) {
        // Reuse a daemon another UI instance already started.
        this.owned = false;
        this.handle = toHandle(existing);
        return this.handle;
      }
      // Healthy but a different version (left over across an app update):
      // adopting it would pair a new renderer with an old daemon API. Tear it
      // down and respawn the bundled version.
      await this.terminate(existing.pid);
    }
    // Not reusable (absent, dead, unhealthy, or stale-version): drop any stale
    // pidfile BEFORE spawning so the poll below can't adopt the old descriptor.
    if (existing) {
      try {
        this.removePidfile(pidfilePath());
      } catch {
        // best-effort
      }
    }
    return this.spawnDaemon(entry);
  }

  /** SIGTERM (lets Nest shutdown hooks drain), SIGKILL past the grace. */
  private async terminate(pid: number): Promise<void> {
    try {
      this.killPid(pid, 'SIGTERM');
    } catch {
      return; // already gone
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
    } catch {
      // already gone
    }
  }

  private async spawnDaemon(entry: string): Promise<DaemonHandle> {
    // Source the Cursor API key from the Keychain and hand it to the daemon in
    // memory (env only — never persisted to disk/SQLite) so its Cursor adapter
    // can authenticate `cursor-agent`. Passed under the GENIRO_-prefixed name so
    // the daemon strips it from every spawned agent's env and re-injects it as
    // CURSOR_API_KEY for the Cursor child ONLY (never the claude child). Absent
    // key → omit; a Cursor turn then surfaces an auth error rather than failing
    // the daemon's start.
    const cursorApiKey = getSecret('cursor.apiKey');
    // A packaged app launched from Finder inherits launchd's minimal PATH,
    // which is missing the user's CLI bin dirs — resolve the login-shell PATH
    // so the daemon can find `claude` / `cursor-agent`. Dev launches already
    // run from a terminal with the right PATH.
    const shellPath = app.isPackaged ? await loginShellPath() : null;
    // Settings cliPaths overrides ride the daemon env (GENIRO_-prefixed, so
    // they are stripped from every agent child); the daemon resolves them into
    // the spawn command for headless turns AND PTY mirrors. A change in
    // Settings applies on the next daemon spawn, like the Cursor key.
    const cliPaths = readSettings().cliPaths;
    const claudeBin = cliPaths['claude']?.trim();
    const cursorBin = cliPaths['cursor-agent']?.trim();
    const child = this.spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ...(shellPath ? { PATH: shellPath } : {}),
        // Run the daemon under Electron's bundled Node — no external runtime.
        ELECTRON_RUN_AS_NODE: '1',
        GENIRO_USER_DATA: app.getPath('userData'),
        ...(cursorApiKey ? { GENIRO_CURSOR_API_KEY: cursorApiKey } : {}),
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
      if (this.owned) {
        this.handle = null;
        this.child = null;
      }
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Only adopt the pidfile OUR child wrote (pid match) — never a stale
      // descriptor that happens to still answer /health on another port.
      const info = this.readInfo(pidfilePath());
      if (
        info &&
        info.pid === child.pid &&
        (await this.checkHealth(info.host, info.port))
      ) {
        this.handle = toHandle(info);
        return this.handle;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `daemon exited during startup (code ${child.exitCode})`,
        );
      }
      await delay(this.pollIntervalMs);
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
    const child = this.child;
    if (!this.owned || !child || child.exitCode !== null) {
      this.handle = null;
      return;
    }
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
    this.handle = null;
    this.child = null;
  }
}
