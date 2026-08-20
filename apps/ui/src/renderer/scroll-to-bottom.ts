/**
 * Put a scroll box at its own bottom, moving NOTHING else.
 *
 * The app's ONE way to follow a tail, and it exists because the obvious way is
 * wrong. `sentinel.scrollIntoView()` is specified to scroll **every scrollable
 * ancestor** of the element — the document included — so a tail-follow that
 * re-runs on each item, each streamed token and each block that finishes
 * measuring will drag the whole window up the moment the shell has picked up
 * any document overflow at all. That is what "it's just always jumping" and the
 * screenshot of the entire UI scrolled off the top, with a page of empty
 * background under it, actually were: nothing was broken in the layout being
 * looked at, the window itself had been scrolled by the transcript.
 *
 * Addressing the scroller directly cannot reach past it, whatever a layout bug
 * above it does. `styles/global.css` clips the window as the second half of the
 * same fix — one keeps the scroll from being asked for, the other keeps it from
 * being possible.
 *
 * Structurally typed rather than taking an `HTMLElement`: jsdom implements
 * neither `scrollTo` nor `scrollIntoView`, so a test drives this through a stub
 * either way.
 */
export function scrollToBottom(
  scroller: {
    scrollHeight: number;
    scrollTo: (options: ScrollToOptions) => void;
  },
  behavior: ScrollBehavior,
): void {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior });
}
