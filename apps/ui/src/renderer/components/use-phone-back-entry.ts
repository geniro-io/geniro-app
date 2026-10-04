import { useCallback, useEffect, useRef } from 'react';

import { randomId } from '../random-id';

/** Marks, in `history.state`, the page's own entry (`PAGE`) and the one under it (`UNDER`). */
const PAGE = 'geniroPhonePage';
const UNDER = 'geniroPhoneUnder';

type EntryState = Record<string, unknown> | null;

function entryState(): EntryState {
  const state: unknown = history.state;
  return typeof state === 'object' && state !== null
    ? (state as Record<string, unknown>)
    : null;
}

/**
 * Give a phone DETAIL page (an open thread, the new-chat composer, a Settings
 * section) a browser history entry, so the platform's own back — iOS Safari's
 * edge swipe, Android's back button — returns to the page under it instead of
 * leaving the app.
 *
 * While `open` is true the page holds one entry pushed on top of the current
 * one (same URL — the shell's hash sync rewrites it with `replaceState`, and
 * must keep `history.state` when it does). The entry under it carries a token
 * and the pushed one names it; a `popstate` that lands on that token is a
 * pop of the page's entry and calls `onBack`. A navigation that ADDS an entry
 * (a link pasted into the tab) lands somewhere without the token, so it is
 * never read as back. The returned function is the app's own way back (its
 * tab pressed again): it pops the entry with `history.back()`, so both ways
 * back run the same `onBack` exactly once.
 *
 * The push waits for a microtask: a page can open in the same commit as a
 * view switch (a jump from Chats into a Settings section), and the shell's
 * hash write for that switch is an effect later in the same flush. Pushed
 * first, the entry underneath would keep the OLD view's hash, and popping
 * back to it would navigate to that view.
 *
 * A page closed some OTHER way (another tab chosen, the thread deleted, the
 * phone rotated wide) does not pop its entry — popping would race the shell's
 * own hash write and navigate off the tab just chosen. When the page opens
 * again while that entry is still current (or after a reload onto it), it
 * ADOPTS the entry rather than pushing a second one, so stale entries never
 * pile up into back presses that do nothing.
 *
 * Pass `open` already gated on the phone width and on the page being on
 * screen, so a hidden view never holds an entry another view's back would pop.
 * `owner` names the page kind: an entry is adopted only by the kind that
 * pushed it, or a Settings section opened by a jump from the chat composer
 * would adopt the composer's entry and pop back to Chats.
 */
export function usePhoneBackEntry(
  owner: string,
  open: boolean,
  onBack: () => void,
): () => void {
  const openRef = useRef(open);
  const pushedRef = useRef(false);
  /** The token the entry under the page carries. */
  const tokenRef = useRef<string | null>(null);
  /** The app's own back asked for a pop that has not been delivered yet. */
  const poppingRef = useRef(false);
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      pushedRef.current = false;
      return;
    }
    queueMicrotask(() => {
      // Re-checked here: the page may have closed again before the microtask,
      // and StrictMode runs this effect twice for one opening.
      if (!openRef.current || pushedRef.current) {
        return;
      }
      const current = entryState();
      const adopted = current?.[PAGE];
      if (typeof adopted === 'string' && adopted.startsWith(`${owner}:`)) {
        tokenRef.current = adopted;
      } else {
        const token = `${owner}:${randomId()}`;
        history.replaceState({ ...current, [UNDER]: token }, '');
        history.pushState({ ...current, [PAGE]: token }, '');
        tokenRef.current = token;
      }
      pushedRef.current = true;
    });
  }, [open, owner]);

  useEffect(() => {
    const onPopState = (): void => {
      const landedUnder =
        tokenRef.current !== null && entryState()?.[UNDER] === tokenRef.current;
      if (poppingRef.current) {
        poppingRef.current = false;
        onBackRef.current();
        return;
      }
      if (!pushedRef.current) {
        return;
      }
      pushedRef.current = false;
      if (landedUnder) {
        onBackRef.current();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return useCallback((): void => {
    if (pushedRef.current) {
      pushedRef.current = false;
      poppingRef.current = true;
      history.back();
    } else if (!poppingRef.current) {
      onBackRef.current();
    }
  }, []);
}
