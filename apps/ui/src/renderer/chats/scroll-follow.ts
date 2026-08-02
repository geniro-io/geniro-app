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
