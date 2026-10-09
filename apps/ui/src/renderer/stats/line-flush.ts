import { reportRendererIssue } from '../debug/report-ui-errors';

/**
 * The flushes of every mounted `useLineSnapshots`, each posting the line measurements its hook holds.
 * They are held here rather than answered by the hook, because a quit must be answered by the shell, which
 * is always mounted, and the hook exists only on the chats screen.
 */
const flushes = new Set<() => Promise<void>>();

/** Registers one hook's flush while the hook is mounted; returns the unregister. */
export function registerLineFlush(flush: () => Promise<void>): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/**
 * Answers a quit's flush request (`main/line-measurement-flush.ts`): every held measurement is posted first,
 * and only then is main told this window is done. A window with nothing held answers at once, so a quit
 * from onboarding or the loading screen does not wait out main's bound.
 */
export function answerLineFlush(requestId: string): void {
  void Promise.allSettled([...flushes].map((flush) => flush()))
    .then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          const reason: unknown = result.reason;
          reportRendererIssue(
            'a line measurement was not posted for the quit',
            {
              error: reason instanceof Error ? reason.message : String(reason),
            },
          );
        }
      }
      return window.geniro.lineMeasurementsFlushed(requestId);
    })
    .catch((error: unknown) => {
      reportRendererIssue('could not answer a quit-time flush', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
