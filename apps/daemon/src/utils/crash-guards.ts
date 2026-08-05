/**
 * Process-level crash guards. Node terminates on an unhandled rejection by
 * default, and that crash bypasses Nest's shutdown hooks — the
 * ProcessRegistry drain and pidfile cleanup never run, orphaning spawned CLI
 * process groups mid-turn. A stray rejection is a bug to log loudly, never a
 * reason to orphan children; an uncaught exception exits through the graceful
 * SIGTERM path so the shutdown hooks still run.
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

  target.on('unhandledRejection', (reason) => {
    log('unhandled promise rejection', reason);
  });
  target.on('uncaughtException', (err) => {
    log('uncaught exception - shutting down', err);
    kill(target.pid, 'SIGTERM');
    setTimeout(() => exit(1), UNCAUGHT_FAILSAFE_EXIT_MS).unref();
  });
}
