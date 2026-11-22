// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { stubCssZoom } from '../__tests__/stub-css-zoom';
import {
  holdReadingPlace,
  READING_ANCHOR_MAX_MS,
  READING_ANCHOR_SETTLE_MS,
  type ReadingAnchorClock,
} from './reading-anchor';

/**
 * A row at a CONTENT offset the spec can move, carrying the jump key every
 * transcript row carries. jsdom computes no layout, so its rect is derived, a
 * negative top margin on the scroller's first child lifting it as layout would.
 */
function placedRow(
  scroller: HTMLElement,
  key: string,
  offset: number,
  height = 100,
): { row: HTMLElement; moveTo: (offset: number) => void } {
  const row = document.createElement('div');
  row.setAttribute('data-jump-key', key);
  let at = offset;
  row.getBoundingClientRect = () => {
    const first = scroller.firstElementChild;
    const lift =
      first instanceof HTMLElement ? parseFloat(first.style.marginTop) || 0 : 0;
    const top = at + lift - scroller.scrollTop;
    return { top, bottom: top + height } as DOMRect;
  };
  return {
    row,
    moveTo: (next) => {
      at = next;
    },
  };
}

function emptyScroller(): HTMLElement {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  return scroller;
}

/**
 * A scroller whose rows sit at fixed CONTENT offsets, so the spec can move a
 * row (something above it grew) or scroll the viewport, and read back where the
 * hold put `scrollTop`.
 */
function makeScroller(rowOffsets: number[]): {
  scroller: HTMLElement;
  rows: HTMLElement[];
  setOffset: (index: number, offset: number) => void;
} {
  const scroller = emptyScroller();
  const placed = rowOffsets.map((offset, index) =>
    placedRow(scroller, `entry:${index}`, offset),
  );
  for (const { row } of placed) {
    scroller.append(row);
  }
  return {
    scroller,
    rows: placed.map(({ row }) => row),
    setOffset: (index, offset) => {
      placed[index]!.moveTo(offset);
    },
  };
}

/**
 * One top-level turn block holding the given rows — the shape a long agent
 * turn takes, whose block an older page continues.
 */
function makeTurnBlock(
  scroller: HTMLElement,
  key: string,
  rows: readonly { key: string; offset: number; height: number }[],
): {
  block: HTMLElement;
  rows: { row: HTMLElement; moveTo: (offset: number) => void }[];
} {
  const top = rows[0]!.offset;
  const last = rows[rows.length - 1]!;
  const { row: block } = placedRow(
    scroller,
    key,
    top,
    last.offset + last.height - top,
  );
  const placed = rows.map((row) =>
    placedRow(scroller, row.key, row.offset, row.height),
  );
  for (const { row } of placed) {
    block.append(row);
  }
  scroller.append(block);
  return { block, rows: placed };
}

const TURN_ROWS = [
  { key: 'row:500', offset: 0, height: 400 },
  { key: 'row:510', offset: 400, height: 500 },
  { key: 'row:520', offset: 900, height: 600 },
  { key: 'row:530', offset: 1_500, height: 1_500 },
];

function manualClock(): ReadingAnchorClock & {
  step: (ms?: number) => void;
  pending: () => number;
} {
  let time = 0;
  let queue: (() => void)[] = [];
  return {
    frame: (callback) => {
      queue.push(callback);
    },
    now: () => time,
    step: (ms = 16) => {
      time += ms;
      const run = queue;
      queue = [];
      for (const callback of run) {
        callback();
      }
    },
    pending: () => queue.length,
  };
}

describe('holdReadingPlace', () => {
  it('pays back growth ABOVE the first visible row, whenever it lands', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350; // row 1 (300–400) is the first visible
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);

    // The page arrives: 5,000px above everything on screen.
    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(5_350);

    // An image above settles two frames later — still held.
    hold.release();
    setOffset(1, 5_420);
    setOffset(2, 6_120);
    clock.step();
    expect(scroller.scrollTop).toBe(5_470);
  });

  it('pays back growth in the scroller’s own pixels under a CSS zoom, where rects read scaled', () => {
    const restore = stubCssZoom(0.5);
    try {
      const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
      for (const row of rows) {
        const local = row.getBoundingClientRect;
        row.getBoundingClientRect = () => {
          const rect = local();
          return { top: rect.top * 0.5, bottom: rect.bottom * 0.5 } as DOMRect;
        };
      }
      scroller.getBoundingClientRect = () =>
        ({ top: 0, bottom: 300 }) as DOMRect;
      scroller.scrollTop = 350;
      const clock = manualClock();
      holdReadingPlace(scroller, clock);

      setOffset(1, 5_300);
      setOffset(2, 6_000);
      clock.step();
      expect(scroller.scrollTop).toBe(5_350);
    } finally {
      restore();
    }
  });

  it('writes nothing while a gesture owns the scroll, then pays the whole shift back once it lets go', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    let gesture = true;
    const hold = holdReadingPlace(scroller, clock, () => gesture);

    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(350);

    // The finger keeps dragging while the shift is owed, and the hold outlives
    // its settle and its cap rather than drop what it owes.
    scroller.scrollTop = 300;
    hold.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(1);
    clock.step(READING_ANCHOR_MAX_MS);
    expect(scroller.scrollTop).toBe(300);
    expect(clock.pending()).toBe(1);

    gesture = false;
    clock.step();
    expect(scroller.scrollTop).toBe(5_300);
    expect(clock.pending()).toBe(0);
  });

  it('lifts the content while a gesture owns the scroll, so the reader sees nothing move, then trades the lift for one scroll write', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    let gesture = true;
    holdReadingPlace(scroller, clock, () => gesture).release();
    const onScreen = (): number => rows[1]!.getBoundingClientRect().top;
    expect(onScreen()).toBe(-50);

    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(350);
    expect(rows[0]!.style.marginTop).toBe('-5000px');
    expect(onScreen()).toBe(-50);

    // A second page lands in front while the finger is still down: the lift
    // moves onto the new first child and grows by what it brought.
    const arrived = document.createElement('div');
    scroller.prepend(arrived);
    setOffset(1, 9_300);
    setOffset(2, 10_000);
    clock.step();
    expect(rows[0]!.style.marginTop).toBe('');
    expect(arrived.style.marginTop).toBe('-9000px');
    expect(onScreen()).toBe(-50);

    gesture = false;
    clock.step();
    expect(arrived.style.marginTop).toBe('');
    expect(scroller.scrollTop).toBe(9_350);
    expect(onScreen()).toBe(-50);
  });

  it('ignores growth BELOW the reader, which a height-delta correction paid back too', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    // A streaming reply grows at the tail; nothing above row 1 moved.
    setOffset(2, 1_900);
    clock.step();
    expect(scroller.scrollTop).toBe(350);
  });

  it('pays back a SHRINK above the reader as well', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 292); // the loading row is 8px shorter than the button
    clock.step();
    expect(scroller.scrollTop).toBe(342);
  });

  it('does not fight the reader scrolling during the hold', () => {
    const { scroller } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    scroller.scrollTop = 120; // the reader keeps going up
    clock.step();
    expect(scroller.scrollTop).toBe(120);
  });

  it('stops once the layout has been still for the settle window after release', () => {
    const { scroller } = makeScroller([0, 300]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);
    clock.step();
    expect(clock.pending()).toBe(1); // still holding while the page loads
    hold.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(0);
  });

  it('never outlives its ceiling, however much keeps moving', () => {
    const { scroller, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);
    hold.release();
    let offset = 300;
    for (let t = 0; t < READING_ANCHOR_MAX_MS; t += 100) {
      offset += 1;
      setOffset(1, offset);
      clock.step(100);
    }
    expect(clock.pending()).toBe(0);
  });

  it('never anchors on the older-messages row the press came from', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300]);
    rows[0]!.dataset.slot = 'older-messages';
    scroller.scrollTop = 0; // the older row (0–100) is the first visible
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 5_300);
    clock.step();
    expect(scroller.scrollTop).toBe(5_000);
  });

  it('prefers a row that STARTS in view over the boundary row the page grows into', () => {
    // Rows 0 (0–100) and 1 (300–400); the reader at 50 sees row 0 cut off at
    // the top and row 1 whole. A page growing INTO row 0 moves nothing about
    // row 0's own top, while everything below it moves.
    const { scroller, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 50;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 1_300);
    clock.step();
    expect(scroller.scrollTop).toBe(1_050);
  });

  it('passes over the TOPMOST row even when it starts in view — the page merges into it', () => {
    // After "Load earlier messages" the reader sits at the very top: the first
    // entry starts in view, and it is the one an older page grows into (and
    // remounts under a new key). The next entry is the stable anchor.
    const { scroller, rows, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 0;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    rows[0]!.remove(); // re-keyed by the merge
    setOffset(1, 1_300);
    clock.step();
    expect(scroller.scrollTop).toBe(1_000);
  });

  it('finds a REMOUNTED anchor by its jump key and still pays the shift', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    // The entry remounts: a new element with the same key, 900px further down.
    rows[1]!.remove();
    const again = document.createElement('div');
    again.setAttribute('data-jump-key', 'entry:1');
    again.getBoundingClientRect = () =>
      ({
        top: 1_200 - scroller.scrollTop,
        bottom: 1_300 - scroller.scrollTop,
      }) as DOMRect;
    scroller.prepend(again);
    setOffset(2, 1_900);
    clock.step();
    expect(scroller.scrollTop).toBe(1_250);
  });

  it('a second load JOINS the running hold rather than paying the shift twice', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const first = holdReadingPlace(scroller, clock);
    first.release(); // a refused load releases at once…
    const second = holdReadingPlace(scroller, clock); // …while the real one starts
    setOffset(1, 5_300);
    clock.step();
    expect(scroller.scrollTop).toBe(5_350);
    expect(clock.pending()).toBe(1);
    second.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(0);
  });

  it('keeps the reader on their row when an older page continues the topmost turn and re-keys its block', () => {
    const scroller = emptyScroller();
    const { block } = makeTurnBlock(scroller, 'entry:500', TURN_ROWS);
    scroller.scrollTop = 1_000;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    block.remove();
    makeTurnBlock(scroller, 'entry:300', [
      { key: 'row:300', offset: 0, height: 2_000 },
      ...TURN_ROWS.map((row) => ({ ...row, offset: row.offset + 2_000 })),
    ]);
    clock.step();
    expect(scroller.scrollTop).toBe(3_000);
  });

  it('passes over the topmost turn’s FIRST row too — a tool group or reasoning run the page continues re-keys it', () => {
    const scroller = emptyScroller();
    const { block } = makeTurnBlock(scroller, 'entry:500', [
      { key: 'row:500', offset: 0, height: 300 },
      { key: 'row:510', offset: 300, height: 400 },
    ]);
    scroller.scrollTop = 0;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    block.remove();
    makeTurnBlock(scroller, 'entry:400', [
      { key: 'row:400', offset: 0, height: 800 },
      { key: 'row:450', offset: 800, height: 500 },
      { key: 'row:510', offset: 1_300, height: 400 },
    ]);
    clock.step();
    expect(scroller.scrollTop).toBe(1_000);
  });

  it('pays back rows an older page adds INSIDE the topmost turn block, whose own top stays put', () => {
    const scroller = emptyScroller();
    const { block, rows } = makeTurnBlock(scroller, 'entry:500', TURN_ROWS);
    scroller.scrollTop = 1_000;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    const { row: older } = placedRow(scroller, 'row:400', 0, 800);
    block.prepend(older);
    rows.forEach(({ moveTo }, index) => moveTo(TURN_ROWS[index]!.offset + 800));
    clock.step();
    expect(scroller.scrollTop).toBe(1_800);
  });

  it('passes over an inner row a closed fold draws no box for', () => {
    const scroller = emptyScroller();
    const { block, rows } = makeTurnBlock(scroller, 'entry:500', TURN_ROWS);
    const { row: folded } = placedRow(scroller, 'row:525', 1_200, 0);
    rows[3]!.row.before(folded);
    scroller.scrollTop = 1_000;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    block.prepend(placedRow(scroller, 'row:400', 0, 800).row);
    rows.forEach(({ moveTo }, index) => moveTo(TURN_ROWS[index]!.offset + 800));
    clock.step();
    expect(scroller.scrollTop).toBe(1_800);
  });

  it('re-anchors on what is visible when its row is regrouped away', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    rows[1]!.remove();
    clock.step(); // re-anchors on row 2, pays nothing this frame
    expect(scroller.scrollTop).toBe(350);
    setOffset(2, 1_200);
    clock.step();
    expect(scroller.scrollTop).toBe(550);
  });
});
