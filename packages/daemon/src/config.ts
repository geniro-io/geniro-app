import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_HOST,
  DAEMON_PIDFILE_NAME,
  DAEMON_PREFERRED_PORT,
  parsePort,
} from '@packages/types';

/** Daemon package version, surfaced in `/health` and the pidfile. */
export const DAEMON_VERSION = '0.1.0';

export interface DaemonConfig {
  /** Directory holding the DB and pidfile (Electron passes its userData path). */
  userDataDir: string;
  /** SQLite database file. */
  dbPath: string;
  /** On-disk daemon descriptor (pidfile). */
  pidfilePath: string;
  /** Port to try first; falls back to a free port if taken. */
  preferredPort: number;
  /** Always loopback. */
  host: string;
  version: string;
}

/**
 * Resolve runtime config from the environment. The Electron shell passes
 * `GENIRO_USER_DATA` (its userData path); standalone/dev runs fall back to
 * `~/.geniro`. The directory is created if missing.
 */
export function loadConfig(): DaemonConfig {
  const userDataDir =
    process.env.GENIRO_USER_DATA?.trim() || join(homedir(), '.geniro');
  mkdirSync(userDataDir, { recursive: true });

  // Strict parse: a malformed GENIRO_PORT falls back to the default rather than
  // binding a surprising port ('4e4'→40000, '0x1234'→4660) or crashing on an
  // out-of-range value ('99999999').
  const preferredPort =
    parsePort(process.env.GENIRO_PORT) ?? DAEMON_PREFERRED_PORT;

  return {
    userDataDir,
    dbPath: join(userDataDir, 'geniro.db'),
    pidfilePath: join(userDataDir, DAEMON_PIDFILE_NAME),
    preferredPort,
    host: DAEMON_HOST,
    version: DAEMON_VERSION,
  };
}
