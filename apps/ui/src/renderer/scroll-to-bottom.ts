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

/**
 * The `scrollTop` that brings one row fully inside its own box — or null when
 * it is already there and nothing should be written.
 *
 * The second half of the rule above, for the other shape of the same want: not
 * "follow the tail" but "keep THIS row visible". `row.scrollIntoView()` is the
 * obvious answer and carries the identical defect — it walks every scrollable
 * ancestor, so a bounded list inside a scrolling panel inside a transcript
 * moves all three. Arithmetic on the box's own `scrollTop` cannot reach past
 * the box.
 *
 * Null for a row already in view is what keeps this from fighting the reader:
 * the caller writes nothing, so a list somebody has scrolled by hand stays
 * where they put it until the row they are meant to be watching actually
 * leaves the frame.
 *
 * Structurally typed, like its neighbour, because jsdom lays nothing out — a
 * test supplies the four numbers directly.
 */
export function revealWithinBox(
  box: { scrollTop: number; clientHeight: number },
  row: { offsetTop: number; offsetHeight: number },
): number | null {
  if (row.offsetTop < box.scrollTop) {
    return row.offsetTop;
  }
  const overshoot = row.offsetTop + row.offsetHeight - box.clientHeight;
  // The row's BOTTOM edge against the box's, so a row taller than the box is
  // shown from its own top rather than scrolled past — `Math.max` with the
  // first case's answer.
  return overshoot > box.scrollTop ? Math.min(overshoot, row.offsetTop) : null;
}
