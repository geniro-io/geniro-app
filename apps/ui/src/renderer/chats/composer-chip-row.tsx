import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import { chipVariants } from '../components/ui/chip';
import { Popover } from '../components/ui/popover';
import { cn } from '../components/ui/utils';

/** Gap between chips, in px — must match the `gap-x-0.5` on the row below. */
const CHIP_GAP = 2;

/** Width assumed for the overflow chip before it has ever been measured. */
const OVERFLOW_CHIP_WIDTH = 32;

/**
 * How many chips fit, given each one's natural width and the room the overflow
 * chip needs once anything is left over. Pure, so the fit rule is testable
 * without a layout engine.
 */
export function fitCount(
  available: number,
  widths: number[],
  overflowWidth: number,
): number {
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count > 0 ? CHIP_GAP : 0) + width;
    if (next > available) {
      break;
    }
    used = next;
    count += 1;
  }
  if (count === widths.length) {
    return count;
  }
  // Something is left over, so the overflow chip has to fit too — drop chips
  // until it does. It can reach 0: a row too narrow for even one chip shows
  // the overflow chip alone, which still reaches every control.
  while (count > 0 && used + CHIP_GAP + overflowWidth > available) {
    count -= 1;
    used -= widths[count]! + (count > 0 ? CHIP_GAP : 0);
  }
  return count;
}

/**
 * The control row under a composer's textarea: the chips on the left, the
 * send/stop actions pinned right.
 *
 * ONE component for BOTH composers (the new-run card and the open transcript's
 * follow-up card) — they had the same markup twice, and the fit rules below
 * are exactly the kind of thing that gets fixed in one copy.
 *
 * **It is always one line.** The chips that fit are rendered; the rest move
 * into a trailing `…` chip that opens them in a popover — the real controls,
 * not rows describing them, so a chip behaves identically wherever it is. It
 * neither wraps (which grew the card and left a band of empty space) nor lets
 * the row overflow (which ran the last chips UNDER the send button and squeezed
 * the folder chip to literally zero width — measured, at 900px).
 *
 * The split is measured, not guessed at breakpoints: chip labels are user data
 * (a folder name, a branch, a model alias), so the same window fits a different
 * number of them from one run to the next.
 */
export function ComposerChipRow({
  children,
  actions,
}: {
  /** The chips — `Chip`s and ghost `Select`s, in priority order. */
  children: React.ReactNode;
  /** Send / Stop / Queue. Never part of the overflow, never shrinks. */
  actions: React.ReactNode;
}): React.JSX.Element {
  // `toArray` drops the `null`s the conditional chips render, and keys what is
  // left — so `chips.length` is what is actually on the row.
  const chips = React.Children.toArray(children);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  /**
   * Each chip's natural width, by position. Cached because a chip in the
   * overflow is not in the row to be measured — without this the row could
   * never work out whether a widened window has room to bring one back.
   */
  const widthsRef = React.useRef<number[]>([]);
  const overflowWidthRef = React.useRef(OVERFLOW_CHIP_WIDTH);
  const [visible, setVisible] = React.useState(chips.length);
  const [open, setOpen] = React.useState(false);

  const measure = React.useCallback((): void => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const shown = Math.min(visible, chips.length);
    const rendered = Array.from(row.children);
    // The chip count changed under the cache (a target switch swaps the whole
    // set): the widths no longer line up with the positions they are keyed by,
    // so start a fresh one. Zeroed rather than emptied, so the loop below still
    // records what IS on the row — an early return here left the cache
    // permanently empty, and a row that never learns a width never overflows.
    if (widthsRef.current.length !== chips.length) {
      widthsRef.current = new Array<number>(chips.length).fill(0);
    }
    for (let i = 0; i < shown; i += 1) {
      const width = rendered[i]?.getBoundingClientRect().width ?? 0;
      if (width > 0) {
        widthsRef.current[i] = width;
      }
    }
    if (shown < chips.length) {
      const width = rendered[shown]?.getBoundingClientRect().width ?? 0;
      if (width > 0) {
        overflowWidthRef.current = width;
      }
    }
    const available = row.clientWidth;
    const widths = widthsRef.current;
    // Nothing measurable — before first layout, or under a test DOM that does
    // no layout at all. Showing everything is the honest answer: it is what a
    // row with room looks like, and hiding controls on a guess is not.
    if (available === 0 || widths.some((width) => !width)) {
      setVisible(chips.length);
      return;
    }
    setVisible(fitCount(available, widths, overflowWidthRef.current));
  }, [chips.length, visible]);

  // Two effects, deliberately. This one runs after EVERY render, because a chip
  // changes width without anything resizing — switch branch, pick a longer
  // model — and the row has to notice. It settles: the state it writes is the
  // same value on the next pass, and React drops an identical update.
  const measureRef = React.useRef(measure);
  measureRef.current = measure;
  React.useLayoutEffect(() => {
    measure();
  });

  // …and this one watches the row itself, for the resizes no render follows:
  // the window, the sidebar, the agents panel. Guarded because a DOM without
  // ResizeObserver (jsdom, under the component tests) has no layout to observe
  // in the first place — there, `measure` finds a zero width and shows every
  // chip, which is what those tests assert against.
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // A popover with nothing left in it would be a dead control — close it when
  // a widening row takes the last chip back.
  React.useEffect(() => {
    if (visible >= chips.length) {
      setOpen(false);
    }
  }, [visible, chips.length]);

  const overflowed = chips.slice(visible);
  return (
    <div className="relative flex items-center gap-2 p-2">
      {/* NOT `overflow-hidden`, tempting as it is as a belt to the
          measurement's braces. Every chip's menu is an absolutely positioned
          descendant of this box, so a clip here cuts each one down to the
          row's own 32px — the menus simply vanish — and, because a clipped box
          is still a scroll container, focusing a menu's search field scrolled
          the whole row sideways under its own chips. */}
      <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-x-0.5">
        {chips.slice(0, visible)}
        {overflowed.length > 0 ? (
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${overflowed.length} more option${overflowed.length === 1 ? '' : 's'}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            title="More options"
            className={cn(chipVariants({ interactive: true }), 'px-1.5')}
            onClick={() => setOpen((current) => !current)}>
            <MoreHorizontal />
          </button>
        ) : null}
      </div>
      {/* Outside the clipped box, anchored to this row — a panel inside it
          would be cut off by the very `overflow-hidden` that protects Send. */}
      <Popover
        open={open && overflowed.length > 0}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        label="More options"
        className="right-12 p-1">
        <div className="flex flex-col items-start gap-0.5">{overflowed}</div>
      </Popover>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </div>
  );
}
