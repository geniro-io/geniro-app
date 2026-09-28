import { linkSync, readFileSync, renameSync, rmSync } from 'node:fs';

import { atomicCreate } from './atomic-file';
import {
  isSameProcess,
  readProcessStartTimes,
  type StartTimeProbe,
} from './process-identity';

/**
 * One daemon per userData dir.
 *
 * The daemon owns a SQLite file, a pidfile, a child journal and a loopback
 * port, and every one of those assumes a single writer. Nothing enforced it:
 * the preferred port being taken makes the daemon fall back to a FREE one, so
 * a second launch bound a different port, wrote its own pidfile over the
 * first's, and ran alongside it sharing the same database — silently, for as
 * long as it lived. Measured here: a `pnpm daemon:dev` daemon 19 hours old,
 * reparented to launchd, still serving on a fallback port while the app's own
 * daemon owned the pidfile.
 *
 * The port fallback stays: a FOREIGN process on 47615 is a real case and must
 * not stop the daemon from starting. What it must not do is let a second
 * GENIRO daemon in, and that is what this lock decides — on the userData dir,
 * which is the resource actually being shared, rather than on the port, which
 * is not.
 *
 * A lock is never trusted on the strength of a pid alone. It records the
 * holder's real process start time, and a boot only yields to a holder whose
 * identity the kernel still confirms (`process-identity`). That is what makes
 * a SIGKILLed daemon's leftover lock self-healing without a timeout to tune: a
 * dead holder cannot be confirmed, so the next launch takes over immediately
 * instead of waiting out a staleness window.
 */

/** Lock file name under the userData dir. */
export const DAEMON_LOCK_FILE_NAME = 'daemon.lock';

/** What the lock file holds — enough to re-identify the holder later. */
interface InstanceLockFile {
  pid: number;
  /** The holder's process start time (epoch ms), as the kernel reports it. */
  startedAt: number;
}

/** Thrown when another daemon is confirmed to be running on this userData dir. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly holderPid: number) {
    super(
      `another geniro daemon (pid ${holderPid}) is already running on this data directory — refusing to start a second one, which would share its database and overwrite its pidfile`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

/** Test seams — production callers pass nothing. */
export interface InstanceLockOptions {
  startTimes?: StartTimeProbe;
  /** The pid to claim the lock for. Defaults to this process. */
  pid?: number;
}

/**
 * Claim the lock, or throw {@link DaemonAlreadyRunningError}.
 *
 * Returns a synchronous release — synchronous because it has to be callable
 * from a `process.on('exit')` handler, which is the last point a clean exit
 * can still tidy up after itself. Releasing is hygiene, not correctness: an
 * unreleased lock is indistinguishable from a crashed one, and the identity
 * check clears both.
 */
export async function acquireInstanceLock(
  path: string,
  options: InstanceLockOptions = {},
): Promise<() => void> {
  const probe = options.startTimes ?? readProcessStartTimes;
  const pid = options.pid ?? process.pid;
  const startedAt = ownStartTime(pid, probe);

  const claim = async (): Promise<boolean> => {
    try {
      await atomicCreate(path, JSON.stringify({ pid, startedAt }));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  };

  if (!(await claim())) {
    const holder = readLock(path);
    // A holder we can still identify owns the directory. Anything else — a
    // dead pid, a recycled one, a file we cannot read — is residue, and the
    // fail-safe direction here is the opposite of the reaper's: refusing to
    // clear residue would leave the app permanently unable to start.
    if (holder && isLive(holder, probe)) {
      throw new DaemonAlreadyRunningError(holder.pid);
    }
    takeOverStale(path, probe);
    if (!(await claim())) {
      // Two launches raced for the same stale lock and the other one won. It
      // is a live daemon by construction, so this launch stands down.
      const winner = readLock(path);
      throw new DaemonAlreadyRunningError(winner?.pid ?? -1);
    }
  }

  return () => releaseInstanceLock(path, pid);
}

/** Whether the process a lock names is still the one that wrote it. */
function isLive(lock: InstanceLockFile, probe: StartTimeProbe): boolean {
  return isSameProcess(lock.pid, lock.startedAt, probe([lock.pid]));
}

/**
 * Per-process counter behind the aside name, on `atomic-file`'s own reasoning:
 * every takeover in this process gets a name no other one will pick.
 */
let asideSeq = 0;

/**
 * Clear a lock judged stale — ATOMICALLY, or stand down.
 *
 * It used to be a plain delete, and a delete removes whatever the name holds
 * AT THAT MOMENT rather than the file that was judged. Two launches meeting one
 * stale lock both judged it, the faster one deleted it and claimed a FRESH
 * lock, and the slower one's delete then removed that fresh lock and claimed
 * its own: two daemons on one database, each believing it held the directory.
 * Not theoretical — driven with two launches lined up a few milliseconds
 * apart, 28 runs of 33 ended with both acquired.
 *
 * So the file is first MOVED to a name only this launch knows — a rename is
 * atomic, so exactly one launch gets any one file — and then judged again,
 * as the file actually taken. If it is still residue it is dropped and the
 * exclusive claim decides the rest. If it turns out to be a LIVE daemon's lock
 * — the faster launch's, claimed between our read and our rename — it is put
 * back under its name and this launch stands down in its favour.
 *
 * What is left is narrower than the race it replaces and needs a THIRD launch:
 * one that claims the name in the instant between our rename and our putting
 * the live lock back. Putting it back is then refused (the name is taken
 * again), the lock of the faster launch is lost, and the launch that claimed in
 * that instant runs beside it. Between two launches — the case measured — the
 * takeover is exact.
 */
function takeOverStale(path: string, probe: StartTimeProbe): void {
  const aside = `${path}.${process.pid}.${asideSeq++}.stale`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Another launch took it aside first. Nothing to clear; the exclusive
      // claim that follows settles which of us holds the directory.
      return;
    }
    throw err;
  }
  const taken = readLock(aside);
  if (taken && isLive(taken, probe)) {
    try {
      // `link`, not `rename`: exclusive, so it can never overwrite a lock a
      // third launch claimed in the meantime.
      linkSync(aside, path);
    } catch {
      // That third launch — see above. Its lock stays; there is nothing this
      // launch can put right from here, and it stands down either way.
    }
    rmSync(aside, { force: true });
    throw new DaemonAlreadyRunningError(taken.pid);
  }
  rmSync(aside, { force: true });
}

/**
 * Drop the lock, if it is still ours.
 *
 * Idempotent and self-checking, because it is called from two places that
 * cannot coordinate: {@link InstanceLockLifecycle} on Nest's shutdown hook,
 * which is the path a clean stop actually takes, and a `process.on('exit')`
 * backstop in `main.ts` for the failures that happen before Nest exists.
 *
 * The ownership check is not a formality. A release that runs late — after a
 * successor has already taken over a lock we abandoned — would delete a LIVE
 * daemon's claim and let a third one in beside it.
 */
export function releaseInstanceLock(
  path: string,
  pid: number = process.pid,
): void {
  if (readLock(path)?.pid === pid) {
    rmSync(path, { force: true });
  }
}

/**
 * The kernel's start time for `pid`, falling back to this process's own uptime.
 *
 * The fallback matters only if `ps` is unavailable: it is accurate to a few
 * milliseconds, which is well inside the identity tolerance, but it can only
 * describe THIS process — so a probe failure degrades the lock to
 * "pid-identified", never to "unidentified".
 */
function ownStartTime(pid: number, probe: StartTimeProbe): number {
  return probe([pid]).get(pid) ?? Date.now() - process.uptime() * 1000;
}

/** The current lock's contents, or null when there is nothing usable to read. */
function readLock(path: string): InstanceLockFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { pid, startedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof startedAt !== 'number') {
      return null;
    }
    return { pid, startedAt };
  } catch {
    return null;
  }
}
