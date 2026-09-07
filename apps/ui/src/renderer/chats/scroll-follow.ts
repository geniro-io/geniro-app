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

/**
 * How far up the loaded window a reader has to be before the page BEFORE it is
 * fetched — 0.3 of the scrollable range, i.e. 70% of the way to the top.
 *
 * REPORTED as "где-то на 70% подгружать все остальные сообщения". A fraction
 * rather than a pixel distance: the window is a thousand rows whose heights
 * range from a one-line tool row to a screenful of diff, so the same pixel
 * budget is half a screen on one thread and thirty on another.
 */
const OLDER_PAGE_AT = 0.3;

/**
 * Whether this scroll should fetch the page of history before the loaded one.
 *
 * Being high up the window is NOT sufficient, and the missing half is a
 * direction: history is paged in because the reader went LOOKING for it, and a
 * viewport travelling toward the newest message is doing the exact opposite.
 *
 * Position alone made pressing "Latest" pay for history nobody asked for.
 * {@link jumpToBottom} animates, so a press from inside the zone below fires
 * `scroll` for every frame of the journey down, and the early frames are still
 * under the threshold — so the pager fired mid-flight, and the caller then held
 * the reader's place with `scroller.scrollTop += …`, a write that TERMINATES a
 * smooth scroll.
 *
 * MEASURED in the running app against a 9,000-item thread, one press: 147,312px
 * of transcript — two full pages, ~2,000 items off the daemon — loaded during a
 * single animation, and the scroll stopped being a scroll (the guarded build
 * animates 93k → 28k → 9k → 1.7k → 0 over about a second; the unguarded one
 * reports 0 at the first sample, having teleported).
 *
 * What it did NOT do is strand the reader, and that is worth writing down
 * because it is the obvious thing to assume: the press sets `following` back on
 * (see the caller), so the growth it triggers re-follows the tail and the
 * viewport still ends at the bottom. The cost is the fetch and the animation,
 * not the destination — this guard is not what fixes a "Latest" that appears to
 * do nothing. Losing the tail to a SHRINKING viewport is that bug, and it lives
 * in the ResizeObserver's watch set rather than here.
 *
 * Direction is taken from the same signal {@link nextFollowState} reads, so the
 * two cannot disagree about which way the viewport went. It also settles the
 * cascade for free: the place-holding write itself moves `scrollTop` DOWN, so
 * the `scroll` it emits can no longer ask for the next page in turn.
 */
export function shouldLoadOlder(
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  previousScrollTop: number,
): boolean {
  if (scroller.scrollTop > previousScrollTop) {
    return false;
  }
  return (
    scroller.scrollTop <=
    (scroller.scrollHeight - scroller.clientHeight) * OLDER_PAGE_AT
  );
}
