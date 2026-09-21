import { useEffect, useState } from 'react';

/**
 * `window.matchMedia` itself, guarded rather than called bare.
 *
 * Every real runtime this app ships to has it (Electron's renderer, any
 * phone browser reaching the LAN gateway); jsdom does not, and this
 * component's OWN unit spec is the only caller that stubs it in — every
 * other spec that happens to mount `Chats` (or anything else on this hook)
 * has no reason to know this hook exists, so the guard belongs here rather
 * than forcing a `vi.stubGlobal('matchMedia', …)` onto specs that are
 * testing something else entirely. `false` (i.e. "not narrow") is the safe
 * default in that case: it is what every existing desktop-focused spec
 * already assumed before this hook existed.
 */
function matches(query: string): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  );
}

/**
 * Whether the window is narrower than `maxWidthPx` right now — the renderer's
 * one way to ask "am I on a phone" outside of a plain CSS class.
 *
 * The Electron shell's own `BrowserWindow` has a `minWidth` of 960 (see
 * `main/index.ts`), so the only way this bundle is ever painted at a phone
 * width is the LAN gateway serving it to a browser on another device (see the
 * root `CLAUDE.md`'s "LAN GATEWAY"). Most of the phone layout can be a `max-*:`
 * Tailwind variant on top of the untouched desktop classes — see
 * `.claude/rules/renderer-design-system.md` on why those stay the default.
 * This hook exists for the handful of places a variant cannot reach: a value
 * computed in TypeScript rather than read off a class list, chief among them
 * the chat screen's `gridTemplateColumns` (an inline style always wins over a
 * class targeting the same property, so no breakpoint variant could ever
 * override it).
 */
export function useNarrowViewport(maxWidthPx = 639): boolean {
  const query = `(max-width: ${maxWidthPx}px)`;
  const [narrow, setNarrow] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = (): void => setNarrow(mql.matches);
    // The query STRING can change between renders (a caller passing a
    // different `maxWidthPx`), so re-read the current match on every effect
    // run rather than trusting the state from a possibly-stale query.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return narrow;
}
