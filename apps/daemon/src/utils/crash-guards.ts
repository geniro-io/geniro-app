/**
 * Process-level crash guards. Node terminates on an unhandled rejection by
 * default, and that crash bypasses Nest's shutdown hooks — the
 * ProcessRegistry drain and pidfile cleanup never run, orphaning spawned CLI
 * process groups mid-turn. A stray rejection is a bug to log loudly, never a
 * reason to orphan children; an uncaught exception exits through the graceful
 * SIGTERM path so the shutdown hooks still run.
 *
 * That SIGTERM-to-self is also the one thing here that can bite: Nest's own
 * SIGTERM listener is what runs the shutdown hooks, so a hook that throws
 * arrives back at this file as another uncaught exception. See the `shuttingDown`
 * latch below — without it, one failed hook spun the daemon into a V8
 * out-of-memory abort, which is the "Electron quit unexpectedly" dialog a user
 * reported seeing periodically.
 */

/**
 * Failsafe hard-exit delay after an uncaught exception, in case the graceful
 * SIGTERM path itself wedges. Coupled across modules: must sit PAST the
 * ProcessRegistry drain (SHUTDOWN_DRAIN_MS = 5s,
 * ../v1/agents/services/process-registry.ts) so a healthy drain finishes
 * first, and INSIDE the UI supervisor's kill grace (SHUTDOWN_GRACE_MS = 7s,
 * apps/ui/src/main/daemon-supervisor.ts) so the daemon exits itself rather
 * than being SIGKILLed mid-drain.
 */
export const UNCAUGHT_FAILSAFE_EXIT_MS = 6500;

/** Test seams — production callers pass nothing. */
export interface CrashGuardHooks {
  log?: (message: string, err: unknown) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  exit?: (code: number) => void;
}

/**
 * The slice of `process` the guards touch: two event registrations and a pid.
 *
 * Stated structurally rather than as `Pick<NodeJS.Process, 'on' | 'pid'>`,
 * which drags in that interface's ~50 `on` overloads — nothing but the real
 * `process` can satisfy them, so a spec could not substitute a plain
 * `EventEmitter` and had to fall back on a cast. A cast here is not a
 * formality: these handlers decide whether a crash reaps the daemon's spawned
 * CLI process groups or orphans them, and installing them on the REAL process
 * during a test run would swallow vitest's own error reporting.
 */
export interface CrashGuardTarget {
  readonly pid: number;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown;
}

export function installCrashGuards(
  hooks: CrashGuardHooks = {},
  target: CrashGuardTarget = process,
): void {
  const log =
    hooks.log ??
    ((message: string, err: unknown) =>
      console.error(message, { err: String(err) }));
  const kill =
    hooks.kill ??
    ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  /**
   * A handler that cannot throw OUT of itself.
   *
   * A throw inside an `uncaughtException` listener is another uncaught
   * exception, which re-enters the same listener — the loop below, reached
   * through the logger instead of through a shutdown hook. The debug sink writes
   * to a file, and a file whose stream has been closed by the shutdown already
   * under way is exactly the case.
   */
  const safely = (what: string, run: () => void): void => {
    try {
      run();
    } catch {
      // Nothing to escalate to: this IS the last-resort handler. Losing the log
      // line is the whole cost; the shutdown below still proceeds.
      try {
        console.error(`crash guard: ${what} itself failed`);
      } catch {
        // A console that throws is not something a guard can report through.
      }
    }
  };

  /**
   * One shutdown, however many exceptions follow — and this latch is the whole
   * reason this file has a re-entry story.
   *
   * SIGTERM-to-self is deliberate (it is what makes Nest run its shutdown hooks
   * rather than the process dying where it stands), but Nest's SIGTERM listener
   * RUNS those hooks — so a hook that throws is an uncaught exception raised
   * from inside the signal handler. Without a latch that lands back here, sends
   * another SIGTERM, and runs the hooks again: an unbounded loop, at ~80,000
   * re-entries per second measured against this module's own built output.
   *
   * It does not merely spin. Every iteration arms a 6.5-second failsafe timer
   * that cannot possibly have fired yet, so roughly half a million live timers
   * and their closures pile up before the first one comes due — which is how a
   * single failed shutdown hook became `node::OOMErrorHandler` and a macOS
   * "Electron quit unexpectedly" dialog. Observed twice on this machine
   * (2026-08-13 12:14 and 12:49) as a daemon at 82% CPU and 3.4GB, with a main
   * thread of `uv__signal_event` → JS → `TriggerUncaughtException` → JS.
   */
  let shuttingDown = false;

  target.on('unhandledRejection', (reason) => {
    safely('unhandled-rejection log', () =>
      log('unhandled promise rejection', reason),
    );
  });
  target.on('uncaughtException', (err) => {
    if (shuttingDown) {
      // A second exception during shutdown is almost always a CONSEQUENCE of the
      // first — a hook that throws, a socket erroring as it is torn down — so it
      // is reported and dropped. Deliberately not a hard exit: the drain that is
      // already running is what keeps spawned CLI groups from being orphaned,
      // and the failsafe armed below ends the process anyway if it wedges.
      safely('shutdown-exception log', () =>
        log('uncaught exception while already shutting down - ignored', err),
      );
      return;
    }
    shuttingDown = true;
    safely('uncaught-exception log', () =>
      log('uncaught exception - shutting down', err),
    );
    safely('self-SIGTERM', () => kill(target.pid, 'SIGTERM'));
    setTimeout(() => exit(1), UNCAUGHT_FAILSAFE_EXIT_MS).unref();
  });
}
