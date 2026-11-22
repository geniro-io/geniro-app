import { continuesUnattended, type InterruptCause } from './stop-cause';

/** What the boot needs from each service that closes an interrupted run. */
export interface InterruptedRunsDeps {
  /** Read and remove the UI's note of why the previous daemon stopped. */
  readCause: () => InterruptCause;
  chats: { reconcileOrphanedRuns: (cause: InterruptCause) => Promise<void> };
  teams: {
    reconcileOrphanedRuns: (cause: InterruptCause) => Promise<void>;
  };
  tasks: { settleCutOffCards: (projectId: null) => Promise<void> };
  /**
   * Forget every continuation an earlier boot recorded and no drain reached —
   * called when this stop is not one the daemon continues after.
   */
  dropRestartContinuations?: () => Promise<void>;
  logError: (message: string) => void;
}

/**
 * Close every run the previous daemon left `running`, and settle the board
 * cards they belonged to.
 *
 * The note is read ONCE, for both reconciles: it describes the one stop that
 * cut off every run either finds. The cards are settled here rather than by
 * `TaskSettleService` hearing the reconciles' status announcements, because at
 * boot it has not subscribed yet — a quit's card would wait for a board to be
 * opened before the autopilot continued it, and a crash's for the hold.
 */
export async function closeInterruptedRuns(
  deps: InterruptedRunsDeps,
): Promise<InterruptCause> {
  const cause = deps.readCause();
  // Before the reconciles: a record left over from an update the daemon then
  // crashed out of must not be continued, nor read as already announced.
  if (!continuesUnattended(cause)) {
    await deps.dropRestartContinuations?.().catch((err: unknown) => {
      deps.logError(
        `could not drop the continuations a crash cut short: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  await deps.chats.reconcileOrphanedRuns(cause);
  await deps.teams.reconcileOrphanedRuns(cause);
  await deps.tasks.settleCutOffCards(null).catch((err: unknown) => {
    deps.logError(
      `boot settle of interrupted task cards failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // Handed back because the note was removed as it was read: whatever else
  // the boot reconciles from it takes this value, never a second read.
  return cause;
}
