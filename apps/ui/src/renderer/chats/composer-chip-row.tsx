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
 *
 * A width of **0 means that position rendered nothing** — a control the current
 * agent does not have (cursor has no effort levels, a CLI with no approval
 * channel has no approval chip, a plain folder has no branch). It costs the row no width and no gap, and can
 * never push a real chip into the overflow; the position is still consumed, so
 * the returned count stays an index into the caller's child list.
 */
export function fitCount(
  available: number,
  widths: number[],
  overflowWidth: number,
): number {
  let used = 0;
  // Positions consumed, empty ones included — what the caller slices by.
  let count = 0;
  // Chips actually occupying the row — what the gaps are counted between.
  let shown = 0;
  for (const width of widths) {
    if (width === 0) {
      count += 1;
      continue;
    }
    const next = used + (shown > 0 ? CHIP_GAP : 0) + width;
    if (next > available) {
      break;
    }
    used = next;
    shown += 1;
    count += 1;
  }
  if (count === widths.length) {
    return count;
  }
  // Something is left over, so the overflow chip has to fit too — drop chips
  // until it does. It can reach 0: a row too narrow for even one chip shows
  // the overflow chip alone, which still reaches every control.
  while (
    count > 0 &&
    used + (shown > 0 ? CHIP_GAP : 0) + overflowWidth > available
  ) {
    count -= 1;
    const width = widths[count]!;
    if (width === 0) {
      continue;
    }
    shown -= 1;
    used -= width + (shown > 0 ? CHIP_GAP : 0);
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
  // `toArray` drops literal `null` children and keys the rest. It does NOT drop
  // a chip COMPONENT that returns null — an effort chip for a CLI with no
  // effort levels is still a child here, rendering nothing. Those positions are
  // real entries in this list and are measured as empty below.
  const chips = React.Children.toArray(children);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  /**
   * Each position's natural width: `null` until it has been measured, `0` for
   * one that renders nothing, its width otherwise. Cached because a chip in the
   * overflow is not in the row to be measured — without this the row could
   * never work out whether a widened window has room to bring one back.
   */
  const widthsRef = React.useRef<(number | null)[]>([]);
  const overflowWidthRef = React.useRef(OVERFLOW_CHIP_WIDTH);
  const [visible, setVisible] = React.useState(chips.length);
  const [open, setOpen] = React.useState(false);

  const measure = React.useCallback((): void => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const shown = Math.min(visible, chips.length);
    // One slot per position on the row, then the overflow chip — see the render
    // below for why the slots exist at all.
    const slots = Array.from(row.children);
    // The chip count changed under the cache (a target switch can swap the
    // whole set): the widths no longer line up with the positions they are
    // keyed by, so start a fresh one.
    if (widthsRef.current.length !== chips.length) {
      widthsRef.current = new Array<number | null>(chips.length).fill(null);
    }
    for (let i = 0; i < shown; i += 1) {
      const chip = slots[i]?.firstElementChild;
      if (!chip) {
        // An empty slot is a chip that rendered nothing — a fact, not a missing
        // measurement, so it is recorded as such rather than left unknown.
        widthsRef.current[i] = 0;
        continue;
      }
      const width = chip.getBoundingClientRect().width;
      if (width > 0) {
        widthsRef.current[i] = width;
      }
    }
    if (shown < chips.length) {
      const width = slots[shown]?.getBoundingClientRect().width ?? 0;
      if (width > 0) {
        overflowWidthRef.current = width;
      }
    }
    const available = row.clientWidth;
    const widths = widthsRef.current;
    // Nothing measurable — before first layout, or under a test DOM that does
    // no layout at all. Showing everything is the honest answer: it is what a
    // row with room looks like, and hiding controls on a guess is not.
    if (available === 0 || widths.some((width) => width === null)) {
      setVisible(chips.length);
      return;
    }
    setVisible(
      fitCount(available, widths as number[], overflowWidthRef.current),
    );
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

  const overflowed = chips.slice(visible);
  // What is left over that actually RENDERS something. A position measured
  // empty carries no control into the menu, so counting it would have the …
  // announce "2 more options" over a menu holding one.
  const overflowCount = overflowed.filter(
    (_, index) => widthsRef.current[visible + index] !== 0,
  ).length;

  // A popover with nothing left in it would be a dead control — close it when
  // a widening row takes the last chip back.
  React.useEffect(() => {
    if (overflowCount === 0) {
      setOpen(false);
    }
  }, [overflowCount]);

  return (
    <div className="relative flex items-center gap-2 p-2">
      {/* NOT `overflow-hidden`, tempting as it is as a belt to the
          measurement's braces. Every chip's menu is an absolutely positioned
          descendant of this box, so a clip here cuts each one down to the
          row's own 32px — the menus simply vanish — and, because a clipped box
          is still a scroll container, focusing a menu's search field scrolled
          the whole row sideways under its own chips. */}
      <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-x-0.5">
        {chips.slice(0, visible).map((chip, index) => (
          // `display: contents` — the chip itself stays the flex item, so a
          // slot changes no layout. It exists so that a chip which renders
          // NOTHING still holds its position among `row.children`: a component
          // returning null (cursor's effort chip, a non-repo
          // folder's branch chip) leaves no element behind, and without a slot
          // every later chip was measured into the WRONG cache entry — so a
          // claude→cursor switch left the row believing it still had to fit
          // two chips that were no longer there, and stranded the branch chip
          // in an overflow menu with 160px of empty row beside it.
          <span key={index} className="contents">
            {chip}
          </span>
        ))}
        {overflowCount > 0 ? (
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${overflowCount} more option${overflowCount === 1 ? '' : 's'}`}
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
        open={open && overflowCount > 0}
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
