/**
 * Leave a trace of an error that escapes the main process.
 *
 * Electron's answer to one is a modal dialog and nothing else: main writes no
 * log of its own, and a packaged Finder launch discards its stdout, so once the
 * dialog is dismissed nothing says what threw or when. This hands the stack to
 * `report` — the daemon's log, through `reportMainLog` — and does nothing more.
 *
 * It listens on `uncaughtExceptionMonitor`, never `uncaughtException`: a
 * monitor runs before Node's own handling and does not count as handling the
 * error, so the dialog, and whether the process survives, stay exactly what
 * Electron would have done without it.
 */
export function reportUncaughtErrors(
  report: (message: string, context: Record<string, string>) => void,
): () => void {
  const listener = (error: unknown, origin: string): void => {
    try {
      report(
        `uncaught error in the main process: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
        { origin },
      );
    } catch {
      // A report that fails must not become a second error on top of this one.
    }
  };
  process.on('uncaughtExceptionMonitor', listener);
  return () => {
    process.off('uncaughtExceptionMonitor', listener);
  };
}
