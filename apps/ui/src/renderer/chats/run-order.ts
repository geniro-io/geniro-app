import type { RunStatusKind } from './run-status';

/**
 * The order the chat sidebar draws its threads in.
 *
 * The list used to be ordered by `createdAt` alone, which is the one fact about
 * a thread that never changes — so a conversation you were in seconds ago sat
 * exactly where it was opened, and a thread that had stopped to ask you
 * something could be anywhere at all. Both halves were reported: threads that
 * need attention should lead, and writing a message should bring its thread up.
 *
 * Three tiers, then recency inside each:
 *
 * 1. **`needs-input`** — the turn is open and cannot advance until a human
 *    answers. It is the only state where the app is waiting on the USER, so it
 *    leads whatever else is going on.
 * 2. **Unseen** — this thread finished, failed or asked while you were
 *    elsewhere and you have not opened it since (the same mark the row's dot
 *    draws, {@link import('./use-unseen-runs')}). News you have not read
 *    outranks a thread you have.
 * 3. Everything else, running threads included. A run that is working needs
 *    nothing from anyone; it reaches the top on its own the moment it produces
 *    a message, through the recency rule below.
 *
 * Inside a tier, newest activity first — `updatedAt`, which the renderer bumps
 * on every live message (the user's included) — with `createdAt` behind it so
 * two threads that have never moved still have a stable, total order rather
 * than one that depends on the array they arrived in.
 *
 * **This deliberately overrides {@link previewSectionRuns}' "the caller's order
 * is preserved" note**, which avoided status ordering because rows then move
 * under the cursor when a turn starts or ends. That cost is real and is the
 * price of what was asked for. It is bounded rather than ignored: the tiers are
 * the two coarse states a user is actually hunting for, so an ordinary turn
 * ending moves a row within its tier at most — only being ASKED something, or
 * opening a thread and clearing its mark, changes tiers at all.
 */
export function sortRunsForSidebar<
  TRun extends { id: string; updatedAt: string; createdAt: string },
>(
  runs: readonly TRun[],
  {
    statusOf,
    unseen,
  }: {
    /** The badge reading for a run — the sidebar's own, never the daemon row. */
    statusOf: (run: TRun) => RunStatusKind;
    /** Run ids carrying the unseen mark. */
    unseen: ReadonlySet<string>;
  },
): TRun[] {
  return [...runs].sort((a, b) => {
    const tier =
      attentionTier(a, statusOf, unseen) - attentionTier(b, statusOf, unseen);
    if (tier !== 0) {
      return tier;
    }
    // ISO-8601 UTC strings from the daemon, so a lexical compare IS a
    // chronological one — and it stays correct for a value the renderer
    // mirrored off an item, which comes from the same clock in the same shape.
    const activity = b.updatedAt.localeCompare(a.updatedAt);
    return activity !== 0 ? activity : b.createdAt.localeCompare(a.createdAt);
  });
}

/** 0 leads. See the tiers in {@link sortRunsForSidebar}. */
function attentionTier<TRun extends { id: string }>(
  run: TRun,
  statusOf: (run: TRun) => RunStatusKind,
  unseen: ReadonlySet<string>,
): number {
  if (statusOf(run) === 'needs-input') {
    return 0;
  }
  return unseen.has(run.id) ? 1 : 2;
}
