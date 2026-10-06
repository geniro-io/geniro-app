import { useEffect, useMemo, useRef, useState } from 'react';

import { isUnread, type UnreadMoments } from './unread';

/**
 * Which threads have done something the user has not looked at yet — and the
 * one place that tells the daemon they have.
 *
 * The ask: "so some status lights up on the thread … so the thread gets
 * highlighted somehow until the user clicks on it". It was then asked to SYNC
 * ("unread or not") between the phone and the desktop, which a mark computed
 * per window from the status broadcasts it happened to receive could not do:
 * a thread opened on the phone stayed bold on the desktop, and a reload forgot
 * every mark. So the mark is now read off the run ROW (`unread.ts`), whose two
 * moments the daemon keeps and broadcasts; this hook only decides what to
 * HIDE and when to report a look.
 *
 * The thread on screen is never drawn unread while the user is WATCHING it —
 * the app on screen, the window visible and focused. That is also when the look
 * is reported: on opening the thread, on coming back to the window, and when
 * the thread earns a fresh mark while being watched. A thread left open on a
 * desktop nobody is at therefore stays unread on the phone until somebody
 * actually looks.
 */
export function useUnseenRuns<TRun extends { id: string } & UnreadMoments>({
  runs,
  activeRunId,
  watching,
  markSeen,
}: {
  /**
   * EVERY thread the window knows, not only the listing on show, so a scope
   * switch cannot hide a thread's mark from the group header that counts it.
   */
  runs: readonly TRun[];
  /** The chat open in this window. */
  activeRunId: string | null;
  /** Whether the user can see that chat right now. */
  watching: boolean;
  /** Report a look: patch the row here and tell the daemon. */
  markSeen: (runId: string) => void;
}): ReadonlySet<string> {
  const unseen = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs) {
      if (isUnread(run) && !(watching && run.id === activeRunId)) {
        ids.add(run.id);
      }
    }
    return ids;
  }, [runs, activeRunId, watching]);

  const active = runs.find((run) => run.id === activeRunId);
  const activeUnread = active !== undefined && isUnread(active);
  const activeAttentionAt = active?.attentionAt ?? null;
  // One report per mark: a re-render while the daemon's answer is in flight
  // must not send the same look again.
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!watching || activeRunId === null || !activeUnread) {
      return;
    }
    const key = `${activeRunId}@${activeAttentionAt ?? ''}`;
    if (reportedRef.current === key) {
      return;
    }
    reportedRef.current = key;
    markSeen(activeRunId);
  }, [watching, activeRunId, activeUnread, activeAttentionAt, markSeen]);

  return unseen;
}

/**
 * Whether the user can see this window right now: shown, and the one with
 * focus. Re-read on every change of either, so a look is reported the moment
 * they come back to a window that was left on a thread.
 */
export function useWindowWatched(): boolean {
  const [watched, setWatched] = useState(isWindowWatched);
  useEffect(() => {
    const update = (): void => setWatched(isWindowWatched());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return watched;
}

function isWindowWatched(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}
