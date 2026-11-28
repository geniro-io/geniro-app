import { useMediaQuery } from './use-media-query';

/**
 * Whether the window is narrower than `maxWidthPx` right now — the renderer's
 * one way to ask "am I on a phone" outside of a plain CSS class.
 *
 * The Electron shell's own `BrowserWindow` has a `minWidth` of 960 (see
 * `main/index.ts`), so the only way this bundle is ever painted at a phone
 * width is the LAN gateway serving it to a browser on another device (see the
 * LAN gateway in `.claude/rules/network-constraints.md`). Most of the phone layout can be a `max-*:`
 * Tailwind variant on top of the untouched desktop classes — see
 * `.claude/rules/renderer-design-system.md` on why those stay the default.
 * This hook exists for the handful of places a variant cannot reach: a value
 * computed in TypeScript rather than read off a class list, chief among them
 * the chat screen's `gridTemplateColumns` (an inline style always wins over a
 * class targeting the same property, so no breakpoint variant could ever
 * override it).
 */
export function useNarrowViewport(maxWidthPx = 639): boolean {
  return useMediaQuery(`(max-width: ${maxWidthPx}px)`);
}
