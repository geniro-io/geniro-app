import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getEnv, type LogLevel } from '@packages/common';

import {
  DAEMON_HOST,
  DAEMON_PIDFILE_NAME,
  DAEMON_PREFERRED_PORT,
  parsePort,
} from '../utils/handshake';

/**
 * Daemon version — surfaced in `/health`, the pidfile, and the UI status line.
 * Read from the daemon's own package.json rather than a hardcoded literal: it
 * sits one level above `environments/` in every layout (source `apps/daemon`,
 * built `dist`, and the packaged `Resources/daemon`), so the tag that
 * scripts/sync-app-version.mjs stamps into it on release is what actually
 * ships — a hardcoded constant silently kept reporting 0.1.0 on tagged builds.
 */
export function readDaemonVersion(
  pkgPath: string = join(__dirname, '..', '..', 'package.json'),
): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the safe default (an unreadable package.json shouldn't
    // crash the daemon; the version is informational).
  }
  return '0.0.0';
}

export const DAEMON_VERSION = readDaemonVersion();

export interface DaemonEnvironment {
  /** Deployment env name (`production` | `development` | `test`). */
  env: string;
  /** App name passed to the bootstrapper/logger. */
  appName: string;
  version: string;
  /** Always loopback — never a routable address. */
  host: string;
  /** Port to try first; falls back to a free port if taken. */
  preferredPort: number;
  /** Directory holding the DB and pidfile (Electron passes its userData path). */
  userDataDir: string;
  /** SQLite database file. */
  dbPath: string;
  /** On-disk daemon descriptor (pidfile). */
  pidfilePath: string;
  logLevel: LogLevel;
  prettyLog: boolean;
}

/**
 * Base (production) environment. The Electron UI passes `GENIRO_USER_DATA` (its
 * userData path); standalone/dev runs fall back to `~/.geniro`. `GENIRO_PORT`
 * overrides the preferred port; a malformed value falls back to the default
 * rather than binding a surprising port. The userData dir is created in
 * `environments/index.ts` (kept out of this factory so it stays pure).
 */
export const environment = (): DaemonEnvironment => {
  const userDataDir =
    process.env.GENIRO_USER_DATA?.trim() || join(homedir(), '.geniro');
  const preferredPort =
    parsePort(process.env.GENIRO_PORT) ?? DAEMON_PREFERRED_PORT;

  return {
    env: getEnv('NODE_ENV', 'production'),
    appName: 'geniro-daemon',
    version: DAEMON_VERSION,
    host: DAEMON_HOST,
    preferredPort,
    userDataDir,
    dbPath: join(userDataDir, 'geniro.db'),
    pidfilePath: join(userDataDir, DAEMON_PIDFILE_NAME),
    logLevel: 'info' as LogLevel,
    prettyLog: false,
  };
};
