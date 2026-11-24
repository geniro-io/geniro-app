import { describe, expect, it } from 'vitest';

import {
  BLOCK_HEAD,
  BLOCK_PAD,
  type GraphBox,
  type GraphGeometry,
  type LayoutBlock,
  layoutBlocks,
  layoutColumn,
  perLineFor,
  withBoxAt,
} from './graph-layout';

const ROOT: GraphBox = { id: 'root', width: 360, height: 112 };
const CARD_WIDTH = 272;
const CARD_HEIGHT = 150;
const COLUMN_GAP = 40;
const LINE_GAP = 72;
const BLOCK_GAP = 24;

function itemsOf(count: number): GraphBox[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    width: 300,
    height: 170,
  }));
}

function cardsOf(
  name: string,
  count: number,
  height = CARD_HEIGHT,
): GraphBox[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${name}-${index + 1}`,
    width: CARD_WIDTH,
    height,
  }));
}

function blockOf(
  name: string,
  count: number,
  height = CARD_HEIGHT,
): LayoutBlock {
  return { id: `block:${name}`, items: cardsOf(name, count, height) };
}

function overlapping(
  geometry: GraphGeometry,
  blocks: readonly LayoutBlock[],
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const owner = new Map<string, string>();
  for (const block of blocks) {
    for (const item of block.items) {
      if (!pinned.has(item.id)) {
        owner.set(item.id, block.id);
      }
    }
  }
  const boxes = [...geometry.boxes.values()];
  const hits: string[] = [];
  boxes.forEach((one, index) => {
    for (const other of boxes.slice(index + 1)) {
      if (owner.get(one.id) === other.id || owner.get(other.id) === one.id) {
        continue;
      }
      if (
        one.x < other.x + other.width &&
        other.x < one.x + one.width &&
        one.y < other.y + other.height &&
        other.y < one.y + one.height
      ) {
        hits.push(`${one.id}/${other.id}`);
      }
    }
  });
  return hits;
}

/** Does any straight segment of a wire pass through a box other than its own end? */
function wiresThroughBoxes(geometry: GraphGeometry): string[] {
  const hits: string[] = [];
  for (const [id, route] of geometry.routes) {
    for (let index = 1; index < route.length; index += 1) {
      const a = route[index - 1]!;
      const b = route[index]!;
      for (const box of geometry.boxes.values()) {
        if (box.id === id) {
          continue;
        }
        if (
          Math.min(a.x, b.x) < box.x + box.width - 1 &&
          Math.max(a.x, b.x) > box.x + 1 &&
          Math.min(a.y, b.y) < box.y + box.height - 1 &&
          Math.max(a.y, b.y) > box.y + 1
        ) {
          hits.push(`${id} through ${box.id}`);
        }
      }
    }
  }
  return hits;
}

const lineTopsOf = (
  geometry: GraphGeometry,
  blocks: readonly LayoutBlock[],
): number =>
  new Set(blocks.map((block) => geometry.boxes.get(block.id)!.y)).size;

describe('perLineFor', () => {
  it('puts four to a line on a small board and at most six on a big one', () => {
    expect(perLineFor(1)).toBe(4);
    expect(perLineFor(12)).toBe(4);
    expect(perLineFor(15)).toBe(5);
    expect(perLineFor(24)).toBe(6);
    expect(perLineFor(60)).toBe(6);
  });
});

describe('layoutBlocks', () => {
  it('centres the root on top and every block under it, none overlapping', () => {
    for (const counts of [[3], [2, 2, 2, 2], [6, 1, 4, 6]]) {
      const blocks = counts.map((count, index) => blockOf(`B${index}`, count));
      const geometry = layoutBlocks(ROOT, blocks, 4);
      const root = geometry.boxes.get('root')!;

      expect(root.x + root.width / 2).toBeCloseTo(geometry.width / 2, 5);
      for (const block of blocks) {
        expect(geometry.boxes.get(block.id)!.y).toBeGreaterThan(
          root.y + root.height,
        );
      }
      for (const box of geometry.boxes.values()) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(geometry.width);
      }
      expect(overlapping(geometry, blocks)).toEqual([]);
    }
  });

  it('stands a block’s footer inside the block on a line under its items, with one wire to the block and none to the footer', () => {
    const more: GraphBox = { id: 'more:block:A', width: 160, height: 32 };
    const blocks: LayoutBlock[] = [
      { ...blockOf('A', 3), footer: more },
      blockOf('B', 1),
    ];
    const geometry = layoutBlocks(ROOT, blocks, 4);
    const frame = geometry.boxes.get('block:A')!;
    const footer = geometry.boxes.get(more.id)!;
    const lowestItem = Math.max(
      ...blocks[0]!.items.map((item) => {
        const box = geometry.boxes.get(item.id)!;
        return box.y + box.height;
      }),
    );

    expect(footer.x).toBe(frame.x + BLOCK_PAD);
    expect(footer.y).toBe(lowestItem + BLOCK_GAP);
    expect(footer.y + footer.height).toBe(frame.y + frame.height - BLOCK_PAD);
    expect([...geometry.routes.keys()].sort()).toEqual(['block:A', 'block:B']);
    expect(lineTopsOf(geometry, blocks)).toBe(1);
  });

  it('keeps a block whose every thread is past the cap, holding only its footer', () => {
    const more: GraphBox = { id: 'more:block:A', width: 160, height: 32 };
    const blocks: LayoutBlock[] = [{ id: 'block:A', items: [], footer: more }];
    const geometry = layoutBlocks(ROOT, blocks, 4);
    const frame = geometry.boxes.get('block:A')!;

    expect(geometry.boxes.get(more.id)!.y).toBe(frame.y + BLOCK_HEAD);
    expect([...geometry.routes.keys()]).toEqual(['block:A']);
  });

  it('lays blocks left to right on one line, and wraps a line once it is perLine cards wide', () => {
    const row = [blockOf('A', 1), blockOf('B', 1), blockOf('C', 1)];
    const one = layoutBlocks(ROOT, row, 4);
    const at = (geometry: GraphGeometry, id: string) => geometry.boxes.get(id)!;
    expect(lineTopsOf(one, row)).toBe(1);
    expect(at(one, 'block:B').x).toBe(
      at(one, 'block:A').x + at(one, 'block:A').width + COLUMN_GAP,
    );
    expect(at(one, 'block:C').x).toBe(
      at(one, 'block:B').x + at(one, 'block:B').width + COLUMN_GAP,
    );

    const wrapped = [blockOf('A', 2), blockOf('B', 1), blockOf('C', 1)];
    const two = layoutBlocks(ROOT, wrapped, 2);
    expect(lineTopsOf(two, wrapped)).toBe(2);
    expect(at(two, 'block:A').y).toBeLessThan(at(two, 'block:B').y);
    expect(at(two, 'block:B').y).toBe(at(two, 'block:C').y);
    expect(at(two, 'block:C').x).toBe(
      at(two, 'block:B').x + at(two, 'block:B').width + COLUMN_GAP,
    );
    const lineLeft = at(two, 'block:B').x;
    const lineRight = at(two, 'block:C').x + at(two, 'block:C').width;
    expect((lineLeft + lineRight) / 2).toBeCloseTo(two.width / 2, 5);
  });

  it('stands a block’s cards in reading order, at most perLine to a line, under its header', () => {
    const block = blockOf('A', 5);
    const geometry = layoutBlocks(ROOT, [block], 2);
    const at = (id: string) => geometry.boxes.get(id)!;
    const host = at(block.id);

    expect(at('A-1').x).toBe(host.x + BLOCK_PAD);
    expect(at('A-1').y).toBe(host.y + BLOCK_HEAD);
    expect(at('A-2').y).toBe(at('A-1').y);
    expect(at('A-2').x).toBe(at('A-1').x + CARD_WIDTH + BLOCK_GAP);
    expect(at('A-3').x).toBe(at('A-1').x);
    expect(at('A-3').y).toBe(at('A-1').y + CARD_HEIGHT + BLOCK_GAP);
    expect(at('A-5').y).toBe(at('A-1').y + 2 * (CARD_HEIGHT + BLOCK_GAP));
    expect(host.height).toBe(
      BLOCK_HEAD + 3 * CARD_HEIGHT + 2 * BLOCK_GAP + BLOCK_PAD,
    );
  });

  it('makes each line of cards as tall as its tallest card, and each line of blocks as tall as its tallest block', () => {
    const tall = {
      id: 'block:tall',
      items: [
        { id: 'tall-1', width: CARD_WIDTH, height: 150 },
        { id: 'tall-2', width: CARD_WIDTH, height: 190 },
      ],
    };
    const blocks = [tall, blockOf('short', 1), blockOf('next', 4)];
    const geometry = layoutBlocks(ROOT, blocks, 4);
    const at = (id: string) => geometry.boxes.get(id)!;

    expect(at('tall-1').y).toBe(at('tall-2').y);
    expect(at(tall.id).height).toBe(BLOCK_HEAD + 190 + BLOCK_PAD);
    expect(at('block:short').y).toBe(at(tall.id).y);
    expect(at('block:next').y).toBe(
      at(tall.id).y + at(tall.id).height + LINE_GAP,
    );
  });

  it('gives each block one wire from the root’s bottom into its top, and none to the cards inside it', () => {
    const blocks = [
      blockOf('A', 2),
      blockOf('B', 1),
      blockOf('C', 1),
      blockOf('D', 3),
    ];
    const geometry = layoutBlocks(ROOT, blocks, 2);
    const root = geometry.boxes.get('root')!;

    for (const block of blocks) {
      const box = geometry.boxes.get(block.id)!;
      const route = geometry.routes.get(block.id)!;
      expect(route[0]).toEqual({
        x: root.x + root.width / 2,
        y: root.y + root.height,
      });
      expect(route.at(-1)).toEqual({ x: box.x + box.width / 2, y: box.y });
      for (const item of block.items) {
        expect(geometry.routes.has(item.id)).toBe(false);
      }
    }
    expect(wiresThroughBoxes(geometry)).toEqual([]);
  });

  it('keeps a pinned card out of its block, gives it a wire of its own, and shrinks the block around the cards left in it', () => {
    const blocks = [blockOf('A', 3)];
    const whole = layoutBlocks(ROOT, blocks, 4).boxes.get('block:A')!;
    const pinned = new Map([['A-2', { x: 500, y: 40 }]]);

    const geometry = layoutBlocks(ROOT, blocks, 4, pinned);
    const root = geometry.boxes.get('root')!;
    const shrunk = geometry.boxes.get('block:A')!;

    expect(shrunk.width).toBe(BLOCK_PAD * 2 + CARD_WIDTH * 2 + BLOCK_GAP);
    expect(shrunk.height).toBe(whole.height);
    expect(geometry.boxes.get('A-2')!.x).toBe(root.x + 500);
    expect(geometry.routes.has('A-2')).toBe(true);
    expect(geometry.routes.has('block:A')).toBe(true);
    expect(overlapping(geometry, blocks, new Set(['A-2']))).toEqual([]);
  });

  it('keeps the block a card is dragged out of at its top-left, shrinking from its right and bottom', () => {
    const blocks = [blockOf('A', 2), blockOf('B', 2)];
    const free = layoutBlocks(ROOT, blocks, 4);
    const geometry = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-2', { x: 900, y: 0 }]]),
      free.width,
    );

    expect(geometry.boxes.get('block:A')).toMatchObject({
      x: free.boxes.get('block:A')!.x,
      y: free.boxes.get('block:A')!.y,
    });
  });

  it('leaves the blocks beside a block a card was dragged out of where they stood', () => {
    const blocks = [blockOf('A', 2), blockOf('B', 2)];
    const free = layoutBlocks(ROOT, blocks, 4);
    const geometry = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-2', { x: 900, y: 0 }]]),
      free.width,
    );

    expect(geometry.boxes.get('block:B')).toMatchObject({
      x: free.boxes.get('block:B')!.x,
      y: free.boxes.get('block:B')!.y,
    });
  });

  it('moves only the block a pinned card lies over, along its line, and leaves every other block where it stood', () => {
    const blocks = [
      blockOf('A', 2),
      blockOf('B', 2),
      blockOf('C', 4),
      blockOf('D', 2),
    ];
    const free = layoutBlocks(ROOT, blocks, 4);
    const root = free.boxes.get('root')!;
    const spot = free.boxes.get('block:B')!;
    const pinned = new Map([
      ['C-4', { x: spot.x - root.x + 12, y: spot.y - root.y + 60 }],
    ]);

    const geometry = layoutBlocks(ROOT, blocks, 4, pinned, free.width);
    const at = (id: string) => geometry.boxes.get(id)!;
    const was = (id: string) => free.boxes.get(id)!;

    expect(overlapping(geometry, blocks, new Set(['C-4']))).toEqual([]);
    expect(at('block:B').x).toBeGreaterThanOrEqual(
      at('C-4').x + at('C-4').width,
    );
    expect(at('block:B').x).toBeGreaterThan(was('block:B').x);
    expect(at('block:B').y).toBe(was('block:B').y);
    for (const id of ['block:A', 'block:D']) {
      expect(at(id)).toMatchObject({ x: was(id).x, y: was(id).y });
    }
  });

  it('stands a pinned card at the root’s top-left plus its offset', () => {
    const blocks = [blockOf('A', 4), blockOf('B', 4)];
    const geometry = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-2', { x: 300, y: 200 }]]),
    );
    const root = geometry.boxes.get('root')!;
    const pinned = geometry.boxes.get('A-2')!;

    expect(pinned.x).toBe(root.x + 300);
    expect(pinned.y).toBe(root.y + 200);
  });

  it('does not move the root when a card is pinned, on the frame it is laid out on', () => {
    const blocks = [blockOf('A', 4), blockOf('B', 4)];
    const free = layoutBlocks(ROOT, blocks, 4);

    const pinned = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-1', { x: 0, y: 2000 }]]),
      free.width,
    );

    expect(pinned.boxes.get('root')).toEqual(free.boxes.get('root'));
    expect(pinned.width).toBe(free.width);
  });

  it('grows the graph to take in a card pinned far right or far below', () => {
    const blocks = [blockOf('A', 2)];
    const right = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-1', { x: 1500, y: 40 }]]),
    );
    const rightBox = right.boxes.get('A-1')!;
    expect(right.width).toBe(rightBox.x + rightBox.width + 24);

    const below = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-1', { x: 0, y: 900 }]]),
    );
    const belowBox = below.boxes.get('A-1')!;
    expect(below.height).toBe(belowBox.y + belowBox.height + 24);
  });

  it('keeps a pinned card the same offset from the root whatever the width of the blocks', () => {
    const offset = { x: 300, y: 200 };
    const offsetFrom = (geometry: GraphGeometry, id: string) => {
      const root = geometry.boxes.get('root')!;
      const box = geometry.boxes.get(id)!;
      return { x: box.x - root.x, y: box.y - root.y };
    };

    const narrow = layoutBlocks(
      ROOT,
      [blockOf('A', 2)],
      4,
      new Map([['A-1', offset]]),
    );
    const wide = layoutBlocks(
      ROOT,
      [blockOf('A', 2), blockOf('B', 2)],
      4,
      new Map([['A-1', offset]]),
    );

    expect(offsetFrom(narrow, 'A-1')).toEqual(offset);
    expect(offsetFrom(wide, 'A-1')).toEqual(offset);
    expect(wide.width).toBeGreaterThan(narrow.width);
  });

  it('starts a pinned wire at the root’s bottom centre and ends it at the top centre of the card', () => {
    const geometry = layoutBlocks(
      ROOT,
      [blockOf('A', 4), blockOf('B', 4)],
      4,
      new Map([['A-2', { x: 700, y: 200 }]]),
    );
    const root = geometry.boxes.get('root')!;
    const pinned = geometry.boxes.get('A-2')!;
    const route = geometry.routes.get('A-2')!;

    expect(route[0]).toEqual({
      x: root.x + root.width / 2,
      y: root.y + root.height,
    });
    expect(route.at(-1)).toEqual({
      x: pinned.x + pinned.width / 2,
      y: pinned.y,
    });
  });

  it('ends a pinned wire at the bottom edge of a card that sits above the bus', () => {
    const geometry = layoutBlocks(
      ROOT,
      [blockOf('A', 4), blockOf('B', 4)],
      4,
      new Map([['A-2', { x: 700, y: 0 }]]),
    );
    const pinned = geometry.boxes.get('A-2')!;

    expect(geometry.routes.get('A-2')!.at(-1)).toEqual({
      x: pinned.x + pinned.width / 2,
      y: pinned.y + pinned.height,
    });
  });

  it('lays out exactly as before when no card is pinned', () => {
    const blocks = [blockOf('A', 4), blockOf('B', 4), blockOf('C', 1)];
    expect(layoutBlocks(ROOT, blocks, 4, new Map())).toEqual(
      layoutBlocks(ROOT, blocks, 4),
    );
  });

  it('centres the root on the frame it is given, however wide a block has grown', () => {
    const blocks = [blockOf('A', 4), blockOf('B', 4)];
    const frame = layoutBlocks(ROOT, blocks, 4).width;
    const grown = [
      {
        id: 'block:A',
        items: [{ id: 'A-1', width: 900, height: CARD_HEIGHT }],
      },
      blockOf('B', 4),
    ];

    const geometry = layoutBlocks(ROOT, grown, 4, new Map(), frame);

    expect(geometry.boxes.get('root')!.x).toBe(frame / 2 - ROOT.width / 2);
    const rightmost = Math.max(
      ...[...geometry.boxes.values()].map((box) => box.x + box.width),
    );
    expect(geometry.width).toBeGreaterThanOrEqual(rightmost);
  });
});

describe('withBoxAt', () => {
  it('stands one box at the root plus its offset with a pinned wire, and leaves every block, box and wire where it was', () => {
    const blocks = [blockOf('A', 4), blockOf('B', 4)];
    const laidOut = layoutBlocks(ROOT, blocks, 4);
    const pinnedThere = layoutBlocks(
      ROOT,
      blocks,
      4,
      new Map([['A-2', { x: 700, y: 200 }]]),
    );

    const moved = withBoxAt(laidOut, 'root', 'A-2', { x: 700, y: 200 });

    expect(moved.boxes.get('A-2')).toEqual(pinnedThere.boxes.get('A-2'));
    expect(moved.routes.get('A-2')).toEqual(pinnedThere.routes.get('A-2'));
    for (const [id, box] of laidOut.boxes) {
      if (id !== 'A-2') {
        expect(moved.boxes.get(id)).toEqual(box);
      }
    }
    for (const [id, route] of laidOut.routes) {
      expect(moved.routes.get(id)).toEqual(route);
    }
    expect([moved.width, moved.height]).toEqual([
      laidOut.width,
      laidOut.height,
    ]);
  });

  it('gives the geometry back as it is for a box it does not hold', () => {
    const laidOut = layoutBlocks(ROOT, [blockOf('A', 2)], 4);

    expect(withBoxAt(laidOut, 'root', 'gone', { x: 10, y: 10 })).toBe(laidOut);
  });
});

describe('layoutColumn', () => {
  it('stacks every box in one column, in order, indented under the root, none overlapping, phone-wide', () => {
    const geometry = layoutColumn(
      { id: 'root', width: 300, height: 112 },
      itemsOf(3),
    );

    expect(
      [...geometry.boxes.values()].sort((a, b) => a.y - b.y).map((b) => b.id),
    ).toEqual(['root', 't0', 't1', 't2']);
    expect(geometry.boxes.get('t0')!.x).toBeGreaterThan(
      geometry.boxes.get('root')!.x,
    );
    expect(overlapping(geometry, [])).toEqual([]);
    expect(wiresThroughBoxes(geometry)).toEqual([]);
    expect(geometry.width).toBeLessThanOrEqual(390);
  });

  it('gives a heading no wire, and the cards under it a wire each', () => {
    const geometry = layoutColumn(
      { id: 'root', width: 300, height: 112 },
      [{ id: 'heading:p', width: 296, height: 28 }, ...itemsOf(2)],
      new Set(['heading:p']),
    );

    expect(geometry.routes.has('heading:p')).toBe(false);
    expect(geometry.routes.has('t0')).toBe(true);
    expect(geometry.boxes.get('heading:p')!.y).toBeLessThan(
      geometry.boxes.get('t0')!.y,
    );
  });
});

describe('perLineFor on a measured canvas', () => {
  it('stands fewer cards to a line on a narrow canvas, so they stay readable, down to one', () => {
    expect(perLineFor(24, 2400, 272)).toBe(6);
    expect(perLineFor(24, 1200, 272)).toBe(4);
    expect(perLineFor(24, 1500, 272)).toBe(5);
    expect(perLineFor(24, 430, 272)).toBe(1);
    expect(perLineFor(24, 900, 272)).toBe(3);
    expect(perLineFor(3, 2400, 272)).toBe(4);
  });
});
