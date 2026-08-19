import { useCallback, useEffect, useRef, useState } from 'react';

import { diffRunNotifications } from '../notifications/run-notifications';
import type { RunStatusKind } from './run-status';

/**
 * Which threads have done something the user has not looked at yet.
 *
 * The ask: "чтобы на треде горел какой-нибудь статус … чтобы тред как-то
 * хайлайтился до нажатия пользователя на него". A banner is gone in five
 * seconds and macOS drops it silently while the display is shared, so the app
 * had no lasting record that a background thread finished, asked something or
 * failed — the sidebar looked exactly as it had before it happened.
 *
 * The trigger is {@link diffRunNotifications}, the SAME rule the banners use,
 * and that is the whole design: a highlight the banner would not have fired for
 * is the two surfaces disagreeing about one run, and the highlight is the half
 * that persists. It brings the three rules with it — a run seen for the first
 * time never marks (the list loads with every past thread already finished), a
 * `cancelled` turn is not an event (the user pressed Stop), and a question
 * outranks a settle.
 *
 * One deliberate difference from the banner: the OPEN chat is never marked, in
 * any window state, where the banner suppresses only while the window has
 * focus. A highlight says "you have not looked at this"; the chat on screen is
 * looked at by definition, and its answer is the first thing the user sees on
 * coming back. Marking it would also strand the mark — the clear happens on
 * ACTIVATION, which a chat that is already active never fires again.
 *
 * Renderer-only and per launch, like the banner's own bookkeeping: it describes
 * what happened while the user was in the app, and nothing here outlives a
 * reload.
 */
export function useUnseenRuns<TRun extends { id: string }>({
  runs,
  statusOf,
  housekeeping,
  activeRunId,
}: {
  runs: readonly TRun[];
  /** The badge reading for a run — the sidebar's own, never the daemon row. */
  statusOf: (run: TRun) => RunStatusKind;
  /**
   * Runs whose latest settle was housekeeping — passed for the same reason the
   * banner passes it, and it is the same set: a mark the banner would not have
   * fired for is the two surfaces disagreeing about one run.
   */
  housekeeping?: ReadonlySet<string>;
  /** The chat on screen, which is never marked. */
  activeRunId: string | null;
}): {
  /** Run ids with something the user has not seen. */
  unseen: ReadonlySet<string>;
  /** The user opened this thread — the mark is theirs to clear by looking. */
  markSeen: (runId: string) => void;
} {
  const seenRef = useRef<ReadonlyMap<string, RunStatusKind>>(new Map());
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(new Set());
  // Read at DIFF time rather than captured, for the reason the notifications
  // hook reads it that way: this effect re-runs on every list change, and a
  // stale active id would mark the wrong chat.
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;

  useEffect(() => {
    const current = new Map(runs.map((run) => [run.id, statusOf(run)]));
    const triggers = diffRunNotifications(
      seenRef.current,
      current,
      housekeeping,
    );
    // Recorded BEFORE the state write, so a transition cannot be counted twice.
    seenRef.current = current;
    setUnseen((prev) => {
      const next = new Set(prev);
      // A deleted chat takes its mark with it — otherwise the set grows for the
      // life of the window and a re-used id would arrive pre-highlighted.
      for (const runId of prev) {
        if (!current.has(runId)) {
          next.delete(runId);
        }
      }
      for (const trigger of triggers) {
        if (trigger.runId !== activeRunIdRef.current) {
          next.add(trigger.runId);
        }
      }
      // Same-size sets with the same members are the common case by far (every
      // keystroke re-runs this), and a fresh Set identity would re-render every
      // memoized row in the sidebar.
      return next.size === prev.size &&
        [...next].every((runId) => prev.has(runId))
        ? prev
        : next;
    });
  }, [runs, statusOf, housekeeping]);

  const markSeen = useCallback((runId: string): void => {
    setUnseen((prev) => {
      if (!prev.has(runId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
  }, []);

  return { unseen, markSeen };
}
