import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireInstanceLock,
  DaemonAlreadyRunningError,
  releaseInstanceLock,
} from './instance-lock';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-lock-'));
  path = join(dir, 'daemon.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A probe that reports exactly the given pid→start-time pairs as alive. */
function alive(entries: [number, number][]) {
  return (pids: number[]): Map<number, number> =>
    new Map(entries.filter(([pid]) => pids.includes(pid)));
}

function lockContents(): { pid: number; startedAt: number } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    pid: number;
    startedAt: number;
  };
}

describe('acquireInstanceLock', () => {
  it('claims a free directory and records who holds it', async () => {
    await acquireInstanceLock(path, {
      pid: 111,
      startTimes: alive([[111, 5_000]]),
    });

    expect(lockContents()).toEqual({ pid: 111, startedAt: 5_000 });
  });

  it('REFUSES when a confirmed live daemon already holds the directory', async () => {
    // The whole point: two daemons on one SQLite file is the bug being fixed.
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: 5_000 }));

    await expect(
      acquireInstanceLock(path, {
        pid: 222,
        startTimes: alive([
          [111, 5_000],
          [222, 9_000],
        ]),
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    // And the incumbent's lock is untouched.
    expect(lockContents().pid).toBe(111);
  });

  it('names the holder, so the failure tells the user which process to look at', async () => {
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: 5_000 }));

    await expect(
      acquireInstanceLock(path, {
        pid: 222,
        startTimes: alive([[111, 5_000]]),
      }),
    ).rejects.toThrow(/pid 111/);
  });

  it('takes over from a daemon that was SIGKILLed — no staleness window to wait out', async () => {
    // The crash case. The holder's pid is simply gone, so it cannot be
    // confirmed and the lock is residue.
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: 5_000 }));

    await acquireInstanceLock(path, {
      pid: 222,
      startTimes: alive([[222, 9_000]]),
    });

    expect(lockContents()).toEqual({ pid: 222, startedAt: 9_000 });
  });

  it('takes over when the holder’s pid was RECYCLED by an unrelated process', async () => {
    // pid 111 is alive, but it started at a different time — it is not the
    // daemon that wrote this lock. Trusting the pid alone would hang the app
    // forever behind a process that has nothing to do with geniro.
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: 5_000 }));

    await acquireInstanceLock(path, {
      pid: 222,
      startTimes: alive([
        [111, 8_888_888],
        [222, 9_000],
      ]),
    });

    expect(lockContents().pid).toBe(222);
  });

  it('takes over an unreadable lock rather than refusing to start forever', async () => {
    writeFileSync(path, 'not json at all');

    await acquireInstanceLock(path, {
      pid: 222,
      startTimes: alive([[222, 9_000]]),
    });

    expect(lockContents().pid).toBe(222);
  });

  it('releases only its own lock, never a successor’s', async () => {
    const release = await acquireInstanceLock(path, {
      pid: 111,
      startTimes: alive([[111, 5_000]]),
    });
    // A takeover happened while our exit handler was still pending.
    writeFileSync(path, JSON.stringify({ pid: 222, startedAt: 9_000 }));

    release();

    expect(lockContents().pid).toBe(222);
  });

  it('removes the lock on release', async () => {
    const release = await acquireInstanceLock(path, {
      pid: 111,
      startTimes: alive([[111, 5_000]]),
    });

    release();

    expect(existsSync(path)).toBe(false);
  });

  it('allows the next launch in after a clean release', async () => {
    const release = await acquireInstanceLock(path, {
      pid: 111,
      startTimes: alive([[111, 5_000]]),
    });
    release();

    await acquireInstanceLock(path, {
      pid: 222,
      startTimes: alive([[222, 9_000]]),
    });

    expect(lockContents().pid).toBe(222);
  });

  it('is released idempotently, and never touches a lock that is not ours', () => {
    // The shutdown hook and the exit backstop both call this, and neither
    // knows whether the other already ran.
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: 5_000 }));

    releaseInstanceLock(path, 111);
    releaseInstanceLock(path, 111);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, JSON.stringify({ pid: 222, startedAt: 9_000 }));
    releaseInstanceLock(path, 111);
    expect(existsSync(path)).toBe(true);
  });

  it('falls back to its own uptime when the OS probe answers nothing', async () => {
    // A probe failure must degrade the lock to pid-identified, not leave it
    // stamped with a start time of NaN that no later check could match.
    await acquireInstanceLock(path, {
      pid: process.pid,
      startTimes: () => new Map(),
    });

    const { startedAt } = lockContents();
    expect(Number.isFinite(startedAt)).toBe(true);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });
});
