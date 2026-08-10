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
  /**
   * The entry script the running daemon started from, as it looked then.
   *
   * Null when the daemon did not report one. Only this app writes this pidfile
   * and the field has been written since it existed, so a null dates the daemon
   * to before the staleness check — which `DaemonSupervisor.mayAdopt` treats as
   * stale and replaces, unlike the other unidentifiable cases it adopts.
   */
  entry: DaemonEntryStamp | null;
  /**
   * When the daemon PROCESS started, epoch ms; null when it did not say.
   *
   * Compared against the kernel's own answer before signalling the pid — a
   * recycled pid is otherwise indistinguishable from the daemon. Null means the
   * daemon predates the field, and the supervisor treats that as "cannot check"
   * rather than as a reason to refuse: the version and entry gates still apply.
   */
  pidStartedAtMs: number | null;
  startedAt: string;
}

/** How an entry script looked when a daemon started from it. */
export interface DaemonEntryStamp {
  path: string;
  mtimeMs: number | null;
  size: number | null;
}

/**
 * Stamp an entry script the same way the daemon stamps its own.
 *
 * TWIN PARSER: `apps/daemon/src/utils/handshake.ts` `stampEntry` produces the
 * value this compares against. The two apps share no code — the pidfile is the
 * whole contract, and this file is deliberately its reader-side mirror (see the
 * header) — so the mtime+size choice must be changed on both sides together or
 * every daemon reads as a different build and is restarted on every launch.
 *
 * `statFile` is a parameter for one reason only: to keep this signature
 * identical to the twin's, so the two read as the same function. Every caller
 * passes `statSync`.
 */
export function stampEntry(
  path: string,
  statFile: (path: string) => { mtimeMs: number; size: number },
): DaemonEntryStamp {
  try {
    const stats = statFile(path);
    return { path, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { path, mtimeMs: null, size: null };
  }
}

function parseEntryStamp(raw: unknown): DaemonEntryStamp | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.path !== 'string' || v.path.length === 0) {
    return null;
  }
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { path: v.path, mtimeMs: num(v.mtimeMs), size: num(v.size) };
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
      // NOT part of the validity test above: a pidfile without it still names
      // a daemon that is genuinely there and genuinely serving. It is only
      // unidentifiable as a build, which the supervisor handles by declining
      // to adopt it rather than by ignoring it.
      entry: parseEntryStamp(v.entry),
      pidStartedAtMs:
        typeof v.pidStartedAtMs === 'number' &&
        Number.isFinite(v.pidStartedAtMs)
          ? v.pidStartedAtMs
          : null,
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
