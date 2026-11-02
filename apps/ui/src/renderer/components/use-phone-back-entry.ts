import { useEffect, useRef } from 'react';

import { randomId } from '../random-id';
import { useLatestCallback } from './use-latest-callback';

/** Marks, in `history.state`, the page's own entry (`PAGE`) and the one under it (`UNDER`). */
const PAGE = 'geniroPhonePage';
const UNDER = 'geniroPhoneUnder';
/** The page tokens of the entries a stack of pages pushed, bottom first. */
const STACK = 'geniroPhoneStack';

function stackOf(state: EntryState): string[] {
  const stack = state?.[STACK];
  if (Array.isArray(stack)) {
    return stack.filter((token): token is string => typeof token === 'string');
  }
  const page = state?.[PAGE];
  return typeof page === 'string' ? [page] : [];
}

type EntryState = Record<string, unknown> | null;

/** Whether `token` names a page of one of the `stacked` kinds (space-separated). */
function isStacked(stacked: string, token: string): boolean {
  return stacked
    .split(' ')
    .some((kind) => kind !== '' && token.startsWith(`${kind}:`));
}

/** The page tokens whose entries an open page holds right now. */
const held = new Set<string>();

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
 * never read as back. The returned function is the app's own way back (a
 * page's ‹ button, its tab pressed again): it pops the entry with
 * `history.back()`, so every way back runs the same `onBack` exactly once.
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
 * would adopt the composer's entry and pop back to Chats. A page that other
 * pages open on top of (a team, whose member opens over it) names their kinds
 * in `stackedOwners`: reopening while one of them is current, it adopts its
 * own entry under them rather than pushing a second one above.
 */
export function usePhoneBackEntry(
  owner: string,
  open: boolean,
  onBack: () => void,
  { stackedOwners = [] }: { stackedOwners?: readonly string[] } = {},
): () => void {
  const stacked = stackedOwners.join(' ');
  const openRef = useRef(open);
  const pushedRef = useRef(false);
  /** The token the entry under the page carries. */
  const tokenRef = useRef<string | null>(null);
  /** The app's own back asked for a pop that has not been delivered yet. */
  const poppingRef = useRef(false);
  /** A stacked page's entry this page reopened under, while it stays on top. */
  const aboveRef = useRef<string | null>(null);
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  const stackedRef = useRef(stacked);
  useEffect(() => {
    stackedRef.current = stacked;
  }, [stacked]);

  const hold = (token: string): void => {
    tokenRef.current = token;
    pushedRef.current = true;
    held.add(token);
  };
  // Every hook's popstate listener sees one pop: a token is let go after the
  // dispatch, unless this page has taken it again by then.
  const letGo = (): void => {
    const token = tokenRef.current;
    pushedRef.current = false;
    if (token === null) {
      return;
    }
    setTimeout(() => {
      if (!pushedRef.current || tokenRef.current !== token) {
        held.delete(token);
      }
    }, 0);
  };

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      letGo();
      aboveRef.current = null;
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
      const stack = stackOf(current);
      const under =
        typeof adopted === 'string' && isStacked(stacked, adopted)
          ? stack.findLast((token) => token.startsWith(`${owner}:`))
          : undefined;
      if (typeof adopted === 'string' && adopted.startsWith(`${owner}:`)) {
        hold(adopted);
      } else if (under !== undefined && typeof adopted === 'string') {
        aboveRef.current = adopted;
        hold(under);
      } else {
        const token = `${owner}:${randomId()}`;
        history.replaceState({ ...current, [UNDER]: token }, '');
        history.pushState(
          { ...current, [PAGE]: token, [STACK]: [...stack, token] },
          '',
        );
        hold(token);
      }
    });
  }, [open, owner, stacked]);

  useEffect(() => {
    const onPopState = (): void => {
      const landedUnder =
        tokenRef.current !== null && entryState()?.[UNDER] === tokenRef.current;
      if (poppingRef.current) {
        poppingRef.current = false;
        letGo();
        onBackRef.current();
        return;
      }
      if (!pushedRef.current) {
        return;
      }
      if (
        tokenRef.current !== null &&
        entryState()?.[PAGE] === tokenRef.current
      ) {
        const marked = entryState()?.[UNDER];
        const above =
          aboveRef.current ??
          (typeof marked === 'string' && isStacked(stackedRef.current, marked)
            ? marked
            : null);
        aboveRef.current = null;
        // A stacked page popped, and this page's own entry is current again.
        // When no open page held the entry popped, the back was meant for
        // this page: pop its own entry too.
        if (above !== null && !held.has(above)) {
          pushedRef.current = false;
          poppingRef.current = true;
          history.back();
        }
        return;
      }
      letGo();
      if (landedUnder) {
        onBackRef.current();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return useLatestCallback((): void => {
    if (pushedRef.current) {
      // Entries a stacked page left above this one's go too.
      const stack = stackOf(entryState());
      const index =
        tokenRef.current === null ? -1 : stack.lastIndexOf(tokenRef.current);
      pushedRef.current = false;
      poppingRef.current = true;
      const depth = index < 0 ? 1 : stack.length - index;
      if (depth === 1) {
        history.back();
      } else {
        history.go(-depth);
      }
    } else if (!poppingRef.current) {
      onBackRef.current();
    }
  }, []);
}
