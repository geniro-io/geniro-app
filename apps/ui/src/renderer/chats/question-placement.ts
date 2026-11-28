/**
 * The chat column height under which an open question on a touch device is
 * drawn in the feed at its own row instead of pinned above the composer: below
 * it the pinned card, up to 60% of the window, leaves the conversation a strip
 * a finger cannot scroll. A device without a touch screen always pins, since a
 * wheel or trackpad scrolls the pinned card and the strip on their own.
 */
export const PIN_QUESTION_MIN_COLUMN_PX = 800;

/**
 * How long the column height must hold before a question is placed by it: a
 * dock that is opening measures several heights (thousands of pixels for a
 * frame) before it settles.
 */
export const COLUMN_SETTLE_MS = 250;

export type QuestionPlacement = 'feed' | 'pinned';

/**
 * Where each open question is drawn, decided once per question and kept while it
 * stays open: its card holds unsent picks and typed text in component state, so
 * a resize or a rotation across the threshold must not remount it. Off a touch
 * device every question is pinned at once. On one, a question is decided only
 * once the column has been measured, and goes to the feed only while
 * its row is drawn — one whose row leaves the loaded window is pinned rather than
 * drawn nowhere. `drawnIds` is null while the thread is opening and draws no
 * rows yet: nothing is decided or moved then.
 *
 * Returns `previous` itself when nothing changed.
 */
export function placeOpenQuestions(
  previous: ReadonlyMap<string, QuestionPlacement>,
  openIds: readonly string[],
  drawnIds: ReadonlySet<string> | null,
  columnHeight: number,
  touchDevice: boolean,
): ReadonlyMap<string, QuestionPlacement> {
  if (drawnIds === null) {
    return previous;
  }
  const next = new Map<string, QuestionPlacement>();
  for (const id of openIds) {
    const kept = previous.get(id);
    if (kept === 'pinned') {
      next.set(id, 'pinned');
    } else if (kept === 'feed') {
      next.set(id, drawnIds.has(id) ? 'feed' : 'pinned');
    } else if (!touchDevice) {
      next.set(id, 'pinned');
    } else if (columnHeight > 0) {
      next.set(
        id,
        drawnIds.has(id) && columnHeight < PIN_QUESTION_MIN_COLUMN_PX
          ? 'feed'
          : 'pinned',
      );
    }
  }
  const unchanged =
    next.size === previous.size &&
    [...next].every(([id, placement]) => previous.get(id) === placement);
  return unchanged ? previous : next;
}
