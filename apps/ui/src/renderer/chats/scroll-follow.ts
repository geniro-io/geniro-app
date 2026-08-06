/**
 * How close to the bottom still counts as "following the tail".
 *
 * Not zero: a smooth scroll can land a fraction of a pixel short, and browsers
 * round `scrollTop` differently under zoom or a fractional device-pixel ratio.
 * A few pixels of slack keeps the tail sticky without ever capturing a user who
 * genuinely scrolled up to read something.
 */
const AT_BOTTOM_SLACK_PX = 24;

/**
 * Whether a scroll container is close enough to its bottom to auto-follow.
 *
 * The transcript scrolls to the newest row only when this holds. Anywhere else
 * the user is reading, and yanking them back down is the defect — suppression
 * is silent, with no "jump to latest" affordance by design.
 *
 * Structurally typed rather than taking an `HTMLElement`, so the arithmetic can
 * be driven directly in a test: jsdom computes no layout, and every one of
 * these three properties reads 0 there.
 */
export function isScrolledToBottom(scroller: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  const distance =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  return distance <= AT_BOTTOM_SLACK_PX;
}

/**
 * Whether the transcript should still be following its tail after a scroll.
 *
 * Reading `isScrolledToBottom` alone at scroll time is not enough, and the two
 * cases it gets wrong are exactly the ones that broke the tail:
 *
 * - **A smooth programmatic scroll fires `scroll` all the way down.** Every
 *   intermediate frame is "not at the bottom", so following would switch itself
 *   off during the very animation that was taking us there.
 * - **Content that grows pushes the bottom away without moving `scrollTop`.**
 *   A thinking block expanding after render leaves the reader where they were
 *   while the distance to the bottom jumps — again "not at the bottom", through
 *   no act of the user.
 *
 * So only a scroll that moved the viewport UP stops the follow: that is the one
 * unambiguous statement of intent ("I am reading something back there"). Reaching
 * the bottom re-arms it, and anything else leaves the decision as it was.
 */
export function nextFollowState(
  following: boolean,
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  previousScrollTop: number,
): boolean {
  if (isScrolledToBottom(scroller)) {
    return true;
  }
  if (scroller.scrollTop < previousScrollTop) {
    return false;
  }
  return following;
}
