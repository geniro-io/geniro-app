/**
 * Daemon ↔ UI handshake contract (daemon-internal).
 *
 * The daemon is the source of truth for the loopback bind: it owns the
 * host/port defaults (overridable via env), binds, then writes the pidfile and
 * stamps the *actual* host + port into it. The Electron UI discovers
 * everything by reading that pidfile — it does NOT import these constants. The
 * only thing both sides agree on out-of-band is the pidfile filename
 * ({@link DAEMON_PIDFILE_NAME}), mirrored by the UI's own reader.
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
 * the UI's reader (`apps/ui/src/main/daemon-pidfile.ts`) — it is the
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
  /**
   * The entry script this daemon is actually RUNNING, and how it looked when
   * it started.
   *
   * `version` cannot answer "is this daemon the current build" — it is the
   * package version, unchanged between rebuilds. The full account of what that
   * cost, and of which unidentifiable cases are adopted anyway, lives at the
   * one site that decides: `DaemonSupervisor.mayAdopt`.
   *
   * `path` is what makes the comparison safe: a supervisor may only call a
   * daemon stale when it started from the SAME file the supervisor itself
   * would start. One run from TypeScript source by `pnpm daemon:dev` reports a
   * different path and is left alone.
   */
  entry: DaemonEntryStamp;
  /**
   * When this PROCESS started, in epoch ms — not when it became healthy.
   *
   * `startedAt` below is the readiness moment, which trails process start by a
   * whole boot (lock, schema sync, listen). A supervisor deciding whether to
   * SIGTERM `pid` needs the kernel's own answer to compare against: pids are
   * recycled, so a bare liveness check cannot tell the daemon from whatever
   * inherited its number. Read from `process.uptime()`, which is exact and free
   * — the alternative is asking `ps` about ourselves.
   */
  pidStartedAtMs: number;
  /** ISO-8601 timestamp the daemon became healthy. */
  startedAt: string;
}

/** How an entry script looked at the moment a daemon started from it. */
export interface DaemonEntryStamp {
  /** Absolute path of the script the daemon is running. */
  path: string;
  /** Its mtime in epoch ms, or null when it could not be read. */
  mtimeMs: number | null;
  /** Its size in bytes, or null when it could not be read. */
  size: number | null;
}

/**
 * Stamp an entry script, for {@link DaemonInfo.entry}.
 *
 * TWIN PARSER: `apps/ui/src/main/daemon-pidfile.ts` re-implements this and
 * compares its result against the value written here. The two apps share no
 * code — the Electron main process must not pull the Nest graph into its
 * bundle, so the pidfile IS the whole contract — and the mtime+size choice
 * must therefore change on both sides together, or every daemon reads as a
 * different build and is restarted on every launch.
 *
 * mtime AND size, not a content hash: the entry is read on every launch and on
 * every adoption check, a hash would have to read the whole bundle each time,
 * and the pair already separates every rebuild that matters — probe-verified
 * that a turbo cache hit leaves both untouched while any real build `rm -rf`s
 * `dist/` and recompiles, moving mtime even for a change that never reaches
 * `main.js` itself.
 *
 * Both null when the file cannot be read. That is "cannot confirm", and the
 * reader decides what to do with it — which is NOT uniformly "replace": see
 * `DaemonSupervisor.mayAdopt`, where an unreadable stamp on either side adopts
 * rather than kill a healthy daemon on no evidence.
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
 *
 * Bypasses `@packages/common`'s `getEnv`, and must: that helper
 * BOOLEAN-COERCES `'0'`/`'1'`/`'on'`/`'off'`, so a port of `'1'` would arrive
 * as `true`. Same reason its own `getEnvPositiveInt` reads `process.env`
 * directly.
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

/**
 * Strictly parse a positive millisecond duration from an env-style string —
 * the `GENIRO_IDLE_EXIT_MS` half of the contract, which the UI supervisor sets
 * and nothing else does.
 *
 * Null means "no window", and every malformed value lands there on purpose: a
 * duration nobody can have meant must switch the feature OFF rather than pick a
 * number on the user's behalf, because the feature in question terminates the
 * daemon. Strict for the same reason as {@link parsePort}.
 */
export function parseDurationMs(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || !/^\d+$/.test(raw.trim())) {
    return null;
  }
  const ms = Number(raw.trim());
  return ms > 0 ? ms : null;
}
