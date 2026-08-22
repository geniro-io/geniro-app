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
 * Two tiers, then recency inside each:
 *
 * 1. **`needs-input`** — the turn is open and cannot advance until a human
 *    answers. It is the only state where the app is waiting on the USER, so it
 *    leads whatever else is going on.
 * 2. Everything else, running threads included. A run that is working needs
 *    nothing from anyone; it reaches the top on its own the moment it produces
 *    a message, through the recency rule below.
 *
 * Inside a tier, newest activity first — `updatedAt`, the moment the DAEMON
 * last wrote the run row, which every client learns live from
 * `RunStatusEvent.at` — with `createdAt` behind it so two threads that have
 * never moved still have a stable, total order rather than one that depends on
 * the array they arrived in.
 *
 * **Nothing here may change when a thread is OPENED**, which is the rule the
 * shape above is built to keep. Every input is a fact the daemon states about
 * every run identically, so clicking a row cannot move it: that is what was
 * reported ("as soon as I click a thread it jumps to the top"), and it had two
 * causes, both of them inputs that only the click could change. One was the
 * renderer inventing `updatedAt` from the transcript it had just loaded — a
 * thread the user was not looking at never streams items, so opening it was the
 * first moment this list learned what time it was. The other was a third tier
 * for UNSEEN runs, sitting between the two above: a click clears that mark by
 * definition, so every visit to a thread with news demoted its own row past
 * everything else that had any. The mark is still drawn — it is the row's dot —
 * it just no longer decides where the row goes, and it barely did: a thread is
 * unseen because it has just done something, which recency already floats.
 *
 * **This deliberately overrides {@link previewSectionRuns}' "the caller's order
 * is preserved" note**, which avoided status ordering because rows then move
 * under the cursor when a turn starts or ends. That cost is real and is the
 * price of what was asked for. It is bounded rather than ignored: the tier is
 * the one coarse state a user is actually hunting for, and being ASKED
 * something is the only transition that changes it.
 */
export function sortRunsForSidebar<
  TRun extends { id: string; updatedAt: string; createdAt: string },
>(
  runs: readonly TRun[],
  {
    statusOf,
  }: {
    /**
     * The badge reading for a run — the sidebar's own, never the daemon row.
     *
     * It must be the reading taken for a run the user is NOT looking at, even
     * for the one they are. The focused reading is derived from the loaded
     * transcript, which arrives a beat after the click, so a thread parked on a
     * question left the leading tier for the length of that fetch and came
     * back: a row jumping down and up again under the pointer that opened it.
     */
    statusOf: (run: TRun) => RunStatusKind;
  },
): TRun[] {
  return [...runs].sort((a, b) => {
    const tier = attentionTier(a, statusOf) - attentionTier(b, statusOf);
    if (tier !== 0) {
      return tier;
    }
    // ISO-8601 UTC strings from the daemon, so a lexical compare IS a
    // chronological one.
    const activity = b.updatedAt.localeCompare(a.updatedAt);
    return activity !== 0 ? activity : b.createdAt.localeCompare(a.createdAt);
  });
}

/** 0 leads. See the tiers in {@link sortRunsForSidebar}. */
function attentionTier<TRun extends { id: string }>(
  run: TRun,
  statusOf: (run: TRun) => RunStatusKind,
): number {
  return statusOf(run) === 'needs-input' ? 0 : 1;
}
