import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_CRASH_MARK_NAME, type DaemonInfo } from './handshake';

/** Atomically write the pidfile (temp + rename) with owner-only permissions. */
export function writePidfile(path: string, info: DaemonInfo): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** Remove the pidfile, ignoring a missing file. */
export function removePidfile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Leave the note that this process is exiting by a CRASH
 * ({@link DAEMON_CRASH_MARK_NAME}): its pid, in the userData dir the supervisor
 * reads it from. Synchronous — it runs just before the crash's self-SIGTERM.
 */
export function writeCrashMark(userDataDir: string, pid: number): void {
  writeFileSync(join(userDataDir, DAEMON_CRASH_MARK_NAME), String(pid), {
    mode: 0o600,
  });
}
