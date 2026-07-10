import { existsSync, readFileSync } from 'node:fs';

/**
 * Reader side of the daemon handshake. The daemon (apps/daemon) is the
 * source of truth — it owns the bind defaults, writes this file, and stamps the
 * actual host + port into it. The UI discovers the daemon solely by reading
 * the file here; it shares no constants with the daemon. The one value both
 * sides must agree on is {@link PIDFILE_NAME} — it is the bootstrap rendezvous
 * point and cannot be fetched over HTTP (you need it to find the port first).
 * It MUST stay identical to the daemon's `DAEMON_PIDFILE_NAME`.
 */
export const PIDFILE_NAME = 'daemon.json';
export const DAEMON_LOOPBACK_HOST = '127.0.0.1';

const MAX_TCP_PORT = 65535;

/** On-disk daemon descriptor written by the daemon (mirror of its shape). */
export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
  version: string;
  startedAt: string;
}

/** Whether a process id could ever name a real running process. */
export function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TCP_PORT
  );
}

/**
 * Validate an untrusted (parsed-JSON) value as a {@link DaemonInfo}. A corrupt
 * or stale pidfile (missing host, non-positive pid, unbindable port) must not
 * round-trip as valid — the supervisor would otherwise adopt a daemon that
 * isn't there.
 */
export function parseDaemonInfo(raw: unknown): DaemonInfo | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (
    typeof v.pid === 'number' &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    v.host === DAEMON_LOOPBACK_HOST &&
    isValidPort(v.port) &&
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.version === 'string' &&
    typeof v.startedAt === 'string'
  ) {
    return {
      pid: v.pid,
      host: v.host,
      port: v.port,
      token: v.token,
      version: v.version,
      startedAt: v.startedAt,
    };
  }
  return null;
}

/** Read and shape-validate the pidfile at `path`; null if absent or malformed. */
export function readDaemonInfo(path: string): DaemonInfo | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseDaemonInfo(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}
