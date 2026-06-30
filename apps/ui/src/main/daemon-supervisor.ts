import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { type DaemonHandle } from '../shared/contracts';
import {
  type DaemonInfo,
  isPlausiblePid,
  PIDFILE_NAME,
  readDaemonInfo,
} from './daemon-pidfile';

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const SHUTDOWN_GRACE_MS = 3_000;

function pidfilePath(): string {
  return join(app.getPath('userData'), PIDFILE_NAME);
}

/**
 * Locate the built daemon entry. Resolved relative to the bundled main process
 * and the app path; M4 packaging will pin a definitive path. Building
 * @geniro/daemon is a prerequisite (turbo build orders it first).
 */
function resolveDaemonEntry(): string {
  const candidates = [
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

function isAlive(pid: number): boolean {
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

async function checkHealth(host: string, port: number): Promise<boolean> {
  try {
    // /health/check is the @packages/http-server readiness endpoint (cloned
    // from Geniro), unauthenticated and version-neutral.
    const res = await fetch(`http://${host}:${port}/health/check`);
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

/**
 * Spawns and supervises the loopback daemon child. Reuses a healthy daemon left
 * running by a prior UI instance (via the pidfile), sweeps orphaned pidfiles,
 * and tears down only the process it owns on quit.
 */
export class DaemonSupervisor {
  private child: ChildProcess | null = null;
  private owned = false;
  private handle: DaemonHandle | null = null;

  async start(): Promise<DaemonHandle> {
    const existing = readDaemonInfo(pidfilePath());
    if (
      existing &&
      isAlive(existing.pid) &&
      (await checkHealth(existing.host, existing.port))
    ) {
      // Reuse a daemon another UI instance already started.
      this.owned = false;
      this.handle = toHandle(existing);
      return this.handle;
    }
    // Not reusable (absent, dead, or alive-but-unhealthy): drop any stale
    // pidfile BEFORE spawning so the poll below can't adopt the old descriptor.
    if (existing) {
      try {
        rmSync(pidfilePath(), { force: true });
      } catch {
        // best-effort
      }
    }
    return this.spawnDaemon();
  }

  private async spawnDaemon(): Promise<DaemonHandle> {
    const entry = resolveDaemonEntry();
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        // Run the daemon under Electron's bundled Node — no external runtime.
        ELECTRON_RUN_AS_NODE: '1',
        GENIRO_USER_DATA: app.getPath('userData'),
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
      const info = readDaemonInfo(pidfilePath());
      if (
        info &&
        info.pid === child.pid &&
        (await checkHealth(info.host, info.port))
      ) {
        this.handle = toHandle(info);
        return this.handle;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `daemon exited during startup (code ${child.exitCode})`,
        );
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
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
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      child.kill('SIGKILL');
    }
    this.handle = null;
    this.child = null;
  }
}
