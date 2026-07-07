import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { type DaemonInfo } from './handshake';

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
