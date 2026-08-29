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
interface Scroller {
  scrollHeight: number;
  scrollTo: (options: ScrollToOptions) => void;
}

/**
 * Keep a box pinned to its own bottom as content arrives. INSTANT, always.
 *
 * The behaviour is not a parameter, and that is the fix rather than a tidy-up:
 * it used to be, five call sites passed it, and the one that got it wrong was
 * the transcript's own tail-follow — the single most important of them.
 *
 * A smooth scroll is an ANIMATION, and re-issuing one cancels the animation
 * still in flight and starts another from where the first had got to. A
 * streaming turn re-issues it on every chunk, which arrive faster than the
 * animation can run, so each call cancels its predecessor and the viewport
 * never advances at all. Measured in the running app: 53 calls across one turn,
 * `scrollTop` 1404 before and 1404 after EVERY one of them, while `scrollHeight`
 * climbed 2228 → 3502. The tail only ever caught up once the stream stopped and
 * the last animation was finally left alone to finish — which is exactly the
 * report: "it just stays in one place while content piles up below".
 *
 * So a follow lands immediately, and cannot be asked to do otherwise. The
 * animated form belongs to {@link jumpToBottom} alone.
 */
export function followTail(scroller: Scroller): void {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
}

/**
 * Take the viewport to the bottom because the USER asked for it.
 *
 * The one place animation is right: it is a single press, nothing re-issues it,
 * and the movement is what tells the reader where they were brought from. The
 * failure above cannot happen here for the same reason it is safe — there is no
 * second call arriving mid-animation.
 */
export function jumpToBottom(scroller: Scroller): void {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
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
