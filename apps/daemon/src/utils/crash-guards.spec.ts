import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHUTDOWN_DRAIN_MS } from '../v1/agents/services/process-registry';
import { installCrashGuards, UNCAUGHT_FAILSAFE_EXIT_MS } from './crash-guards';

/**
 * A fake process target so the guards never touch the spec's own process
 * listeners (an uncaughtException handler on the real process would swallow
 * vitest's error reporting).
 */
function fakeProcess(): EventEmitter & { pid: number } {
  return Object.assign(new EventEmitter(), { pid: 4242 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('installCrashGuards', () => {
  it('logs an unhandled rejection and keeps the daemon alive (no kill, no exit)', () => {
    const log = vi.fn();
    const kill = vi.fn();
    const exit = vi.fn();
    const target = fakeProcess();
    installCrashGuards({ log, kill, exit }, target);

    target.emit('unhandledRejection', new Error('floating'));

    // A stray rejection must not crash past the ProcessRegistry drain and
    // pidfile cleanup, orphaning spawned CLI process groups.
    expect(log).toHaveBeenCalledWith(
      'unhandled promise rejection',
      expect.any(Error),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('an uncaught exception exits via graceful SIGTERM, hard-exiting only at the failsafe deadline', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const kill = vi.fn();
    const exit = vi.fn();
    const target = fakeProcess();
    installCrashGuards({ log, kill, exit }, target);

    target.emit('uncaughtException', new Error('boom'));

    // Graceful path first: SIGTERM triggers Nest's shutdown hooks (child
    // reaping + pidfile removal) — no immediate hard exit.
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(UNCAUGHT_FAILSAFE_EXIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('the failsafe sits past the registry drain but inside the UI kill grace', () => {
    // Cross-module invariant: a drive-by bump of either constant that closes
    // this window orphans children mid-drain. The daemon-side half pins the
    // LIVE constant; the UI-side SHUTDOWN_GRACE_MS (7s, apps/ui
    // daemon-supervisor.ts) is a separate app with no shared package, so the
    // literal stays — the pointer comment is its discoverability.
    expect(UNCAUGHT_FAILSAFE_EXIT_MS).toBeGreaterThan(SHUTDOWN_DRAIN_MS);
    expect(UNCAUGHT_FAILSAFE_EXIT_MS).toBeLessThan(7000);
  });
});
