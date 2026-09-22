import type { DaemonApis } from '../daemon-api';

/**
 * Where {@link reportRendererIssue} sends, once {@link reportUiErrors} has
 * wired it. Null before that and after the teardown, which is the honest state
 * rather than a queue: a line nobody can send yet describes a window that has
 * not finished starting.
 */
let issueSink:
  ((message: string, context: Record<string, string>) => void) | null = null;

/**
 * Report a renderer ANOMALY the code caught itself — an invariant that was
 * supposed to hold and did not — to the same daemon log the uncaught errors go
 * to.
 *
 * Distinct from an uncaught error on purpose: nothing threw, and the window is
 * still working. What it buys is that a defect somebody can only describe
 * ("I saw sub-agents from another thread") names its own path the next time it
 * happens, in a file the user can paste. It is deliberately one line and never
 * a throw — a guard that crashed the window it was protecting would be worse
 * than the defect.
 *
 * Shares {@link reportUiErrors}' de-duplication, so a loop cannot flood the log.
 */
export function reportRendererIssue(
  message: string,
  context: Record<string, string>,
): void {
  issueSink?.(message, context);
}

/**
 * Send this window's uncaught errors to the daemon's log.
 *
 * The browser console is not somewhere a user can hand you: it lives behind
 * devtools nobody opens, and it is gone the moment the window reloads. Routed
 * to the daemon these land in the same file and the same ordered stream as
 * everything else, so "the UI threw" sits beside what the daemon was doing at
 * that instant — which is the whole reason to keep one log rather than two.
 *
 * Two sources, because they are genuinely different failures and only one of
 * them reaches `window.onerror`: a synchronous throw, and a promise nobody
 * caught (which is most of this codebase's daemon calls).
 */
export function reportUiErrors(apis: DaemonApis): () => void {
  /**
   * Identical messages already sent, so one broken render loop cannot flood
   * the log with the same line thousands of times — which would push out the
   * entries explaining what led to it.
   */
  const seen = new Set<string>();
  const MAX_DISTINCT = 100;

  const send = (message: string, context: Record<string, string>): void => {
    if (seen.has(message) || seen.size >= MAX_DISTINCT) {
      return;
    }
    seen.add(message);
    // Fire-and-forget, and its own failure is SWALLOWED on purpose: this runs
    // inside an error handler, so a rejection here would be a second uncaught
    // error reported by the thing reporting errors.
    void apis.diagnostics
      .recordUiLog({
        uiLogDto: { level: 'error', message: message.slice(0, 8_000), context },
      })
      .catch(() => undefined);
  };

  const onError = (event: ErrorEvent): void => {
    send(
      event.error instanceof Error ? errorText(event.error) : event.message,
      {
        kind: 'uncaught',
        at: `${event.filename}:${event.lineno}:${event.colno}`,
      },
    );
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    send(reason instanceof Error ? errorText(reason) : String(reason), {
      kind: 'unhandled-rejection',
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // The caught-anomaly channel rides the same sender, so it inherits the
  // de-duplication and the swallowed failure rather than growing its own.
  issueSink = send;
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    issueSink = null;
  };
}

/** An error as text — the stack when there is one, since that is the evidence. */
function errorText(error: Error): string {
  return error.stack ?? `${error.name}: ${error.message}`;
}
