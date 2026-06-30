import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { type DaemonInfo, isPlausiblePid, parseDaemonInfo } from './handshake';

/** Mint a per-launch loopback session token (256 bits, hex). */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/** Atomically write the pidfile (temp + rename) with owner-only permissions. */
export function writePidfile(path: string, info: DaemonInfo): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** Read and shape-validate the pidfile; returns null if absent or malformed. */
export function readPidfile(path: string): DaemonInfo | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseDaemonInfo(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Remove the pidfile, ignoring a missing file. */
export function removePidfile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Whether a process with `pid` is currently running. */
export function isProcessAlive(pid: number): boolean {
  // Guard non-positive/non-integer pids: process.kill(0,…) signals the caller's
  // own group and kill(-1,…) broadcasts — both succeed and would falsely report
  // a corrupt pidfile's daemon as alive, so it would never be swept.
  if (!isPlausiblePid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but owned by another user (treat as alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Orphan sweep: if the pidfile points at a dead process, delete it and return
 * null; if it points at a live process, return the descriptor for reuse.
 */
export function reconcilePidfile(path: string): DaemonInfo | null {
  const info = readPidfile(path);
  if (!info) {
    return null;
  }
  if (isProcessAlive(info.pid)) {
    return info;
  }
  removePidfile(path);
  return null;
}
