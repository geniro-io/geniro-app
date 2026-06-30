/**
 * Daemon ↔ shell handshake contract (daemon-internal).
 *
 * The daemon is the source of truth for the loopback bind: it owns the
 * host/port defaults (overridable via env), binds, then writes the pidfile and
 * stamps the *actual* host + port into it. The Electron shell discovers
 * everything by reading that pidfile — it does NOT import these constants. The
 * only thing both sides agree on out-of-band is the pidfile filename
 * ({@link DAEMON_PIDFILE_NAME}), mirrored by the shell's own reader.
 */

/** Host the daemon always binds to — loopback only, never a routable address. */
export const DAEMON_HOST = '127.0.0.1';

/**
 * Preferred loopback port. `GENIRO_PORT` overrides it; if the port is taken the
 * daemon falls back to a free one and records the bound port in the pidfile.
 */
export const DAEMON_PREFERRED_PORT = 47615;

/**
 * Pidfile name under the userData dir. MUST stay identical to the literal in
 * the shell's reader (`apps/shell/src/main/daemon-pidfile.ts`) — it is the
 * bootstrap rendezvous point and cannot be discovered over HTTP.
 */
export const DAEMON_PIDFILE_NAME = 'daemon.json';

/** Highest valid TCP port. */
export const MAX_TCP_PORT = 65535;

/**
 * On-disk daemon descriptor (the "pidfile"). Written only AFTER the schema is
 * migrated and the server is listening, so a reader never connects to a
 * half-booted daemon. The bearer `token` is a per-launch LOCAL session token
 * (it gates other localhost processes, not the user) — not a user secret, and
 * allowed on disk. User credentials live in the macOS Keychain only.
 */
export interface DaemonInfo {
  /** OS process id of the running daemon. */
  pid: number;
  /** Loopback host the daemon bound to (always 127.0.0.1). */
  host: string;
  /** Loopback port actually bound (preferred port, else a free fallback). */
  port: number;
  /** Bearer token minted for this launch; required on every HTTP/WS request. */
  token: string;
  /** Daemon package version (semver). */
  version: string;
  /** ISO-8601 timestamp the daemon became healthy. */
  startedAt: string;
}

/** True when `value` is a bindable TCP port (integer in 1..65535). */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TCP_PORT
  );
}

/**
 * Strictly parse a port from an env-style string. Rejects anything that isn't
 * pure decimal digits in range — so `'4e4'`, `'0x1234'`, `'80.5'`, `'99999999'`,
 * empty/whitespace all return null (caller falls back to a default). Lenient
 * `Number()` coercion would silently accept those.
 */
export function parsePort(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const port = Number(trimmed);
  return isValidPort(port) ? port : null;
}

/** Whether a process id could ever name a real running process. */
export function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Validate an untrusted (parsed-JSON) value as a {@link DaemonInfo}. Single
 * source of truth for the pidfile shape on the writer side. Rejects a
 * non-positive/non-integer pid, a missing host, and an unbindable
 * (non-integer / out-of-range) port — a corrupt pidfile must not round-trip.
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
    typeof v.host === 'string' &&
    v.host.length > 0 &&
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
