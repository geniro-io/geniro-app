import { type InterruptCause } from './stop-cause';

/** What the boot needs from each service that closes an interrupted run. */
export interface InterruptedRunsDeps {
  /** Read and remove the UI's note of why the previous daemon stopped. */
  readCause: () => InterruptCause;
  chats: { reconcileOrphanedRuns: (cause: InterruptCause) => Promise<void> };
  workflows: {
    reconcileOrphanedRuns: (cause: InterruptCause) => Promise<void>;
  };
  tasks: { settleCutOffCards: (projectId: null) => Promise<void> };
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
): Promise<void> {
  const cause = deps.readCause();
  await deps.chats.reconcileOrphanedRuns(cause);
  await deps.workflows.reconcileOrphanedRuns(cause);
  await deps.tasks.settleCutOffCards(null).catch((err: unknown) => {
    deps.logError(
      `boot settle of interrupted task cards failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
