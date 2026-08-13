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

  it('shuts down ONCE however many exceptions the shutdown itself raises', () => {
    // THE crash. SIGTERM-to-self is what makes Nest run its shutdown hooks, and
    // Nest runs them INSIDE its SIGTERM listener — so a hook that throws lands
    // back here as another uncaught exception. Unlatched, that sent another
    // SIGTERM and ran the hooks again: measured at ~80,000 re-entries/second
    // against this module's built output, each arming a 6.5s failsafe timer that
    // cannot have fired yet, so the timers and their closures pile up until V8
    // aborts. That abort is the macOS "Electron quit unexpectedly" dialog.
    vi.useFakeTimers();
    const log = vi.fn();
    const exit = vi.fn();
    const target = fakeProcess();
    // Stands in for Nest's own listener: it runs the hooks, and one throws.
    const kill = vi.fn(() => {
      target.emit('uncaughtException', new Error('a shutdown hook failed'));
    });
    installCrashGuards({ log, kill, exit }, target);

    target.emit('uncaughtException', new Error('boom'));

    // Exactly one shutdown attempt, and exactly one failsafe timer behind it.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'uncaught exception while already shutting down - ignored',
      expect.any(Error),
    );
    vi.advanceTimersByTime(UNCAUGHT_FAILSAFE_EXIT_MS * 2);
    // One timer, so one exit — not one per re-entry.
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still shuts down when the LOGGER is what throws', () => {
    // The same loop reached through the other door: a throw inside an
    // uncaughtException listener is itself an uncaught exception. The debug sink
    // writes to a file, and a stream closed by the shutdown already under way is
    // exactly that case — so the log must never be able to throw out of here.
    vi.useFakeTimers();
    const kill = vi.fn();
    const exit = vi.fn();
    const target = fakeProcess();
    const log = vi.fn(() => {
      throw new Error('the log sink is closed');
    });
    installCrashGuards({ log, kill, exit }, target);

    expect(() =>
      target.emit('uncaughtException', new Error('boom')),
    ).not.toThrow();
    // The shutdown still happened — losing the line is the whole cost.
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    vi.advanceTimersByTime(UNCAUGHT_FAILSAFE_EXIT_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a throwing rejection logger does not become an uncaught exception', () => {
    // `unhandledRejection` only logs, so a throwing logger there is the cheapest
    // possible way to manufacture the crash above out of nothing.
    const target = fakeProcess();
    installCrashGuards(
      {
        log: () => {
          throw new Error('the log sink is closed');
        },
        kill: vi.fn(),
        exit: vi.fn(),
      },
      target,
    );

    expect(() =>
      target.emit('unhandledRejection', new Error('floating')),
    ).not.toThrow();
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
