import { execFileSync, spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  isSameProcess,
  PROCESS_IDENTITY_TOLERANCE_MS,
  readProcessStartTimes,
} from './process-identity';

describe('readProcessStartTimes', () => {
  it('reads this process’s real start time from the OS', () => {
    const started = readProcessStartTimes([process.pid]);

    const own = started.get(process.pid);
    expect(own).toBeDefined();
    // Our own uptime bounds it: the value must sit in the past, and no
    // earlier than when this process began. Asserting against `process.uptime`
    // rather than a fixture is what makes this fail if the `ps` output format
    // or the parse ever drifts.
    const uptimeStart = Date.now() - process.uptime() * 1000;
    expect(own!).toBeLessThanOrEqual(Date.now());
    expect(own!).toBeGreaterThanOrEqual(uptimeStart - 5_000);
  });

  it('agrees with an independent read of the same pid', () => {
    // The parse is the thing under test, so the oracle must come from ps
    // itself rather than from this spec's own arithmetic.
    const raw = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(process.pid)],
      {
        encoding: 'utf8',
      },
    ).trim();

    expect(readProcessStartTimes([process.pid]).get(process.pid)).toBe(
      Date.parse(raw),
    );
  });

  it('omits a pid that has exited instead of guessing at it', async () => {
    // A REAL just-exited pid, which is exactly what a stale journal holds —
    // not an invented number, which `ps` would reject on different grounds.
    const dead = spawnSync('true');
    const deadPid = dead.pid!;

    const started = readProcessStartTimes([1, deadPid]);

    expect(started.has(1)).toBe(true);
    expect(started.has(deadPid)).toBe(false);
  });

  it('still answers for the live pids when ps rejects one of the ids', () => {
    // `ps` validates every id and fails the WHOLE invocation on one it
    // dislikes. Without the per-pid fallback this returns empty, and a boot
    // reap then silently kills nothing at all.
    const started = readProcessStartTimes([1, 999_999_998]);

    expect(started.has(1)).toBe(true);
    expect(started.has(999_999_998)).toBe(false);
  });

  it('returns nothing, without spawning, for an empty pid list', () => {
    expect(readProcessStartTimes([]).size).toBe(0);
  });
});

describe('isSameProcess', () => {
  const probed = new Map([[42, 1_000_000]]);

  it('confirms a pid whose start time matches what was recorded', () => {
    expect(isSameProcess(42, 1_000_000, probed)).toBe(true);
  });

  it('accepts the sub-second skew between our clock read and ps’s rounding', () => {
    expect(isSameProcess(42, 1_000_000 + 999, probed)).toBe(true);
  });

  it('REFUSES a recycled pid: same number, different start time', () => {
    // The whole point of the check. Without it this pid would be SIGKILLed —
    // it could be the user's own interactive CLI.
    expect(
      isSameProcess(42, 1_000_000 + PROCESS_IDENTITY_TOLERANCE_MS + 1, probed),
    ).toBe(false);
  });

  it('refuses a pid the probe never saw', () => {
    expect(isSameProcess(43, 1_000_000, probed)).toBe(false);
  });
});
