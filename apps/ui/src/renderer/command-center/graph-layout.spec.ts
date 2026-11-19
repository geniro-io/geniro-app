import { describe, expect, it } from 'vitest';

import {
  bandRows,
  type GraphBox,
  type GraphGeometry,
  layoutColumn,
  layoutRows,
  perLineFor,
} from './graph-layout';

const ROOT: GraphBox = { id: 'root', width: 360, height: 112 };

function itemsOf(count: number): GraphBox[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    width: 300,
    height: 170,
  }));
}

function overlaps(geometry: GraphGeometry): string[] {
  const boxes = [...geometry.boxes.values()];
  const hits: string[] = [];
  boxes.forEach((one, index) => {
    for (const other of boxes.slice(index + 1)) {
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

const linesOf = (geometry: GraphGeometry): number =>
  new Set(
    [...geometry.boxes.values()]
      .filter((box) => box.id !== 'root')
      .map((box) => box.y),
  ).size;

function rowsOf(count: number, perLine: number): GraphBox[][] {
  return bandRows([itemsOf(count)], perLine);
}

describe('perLineFor', () => {
  it('puts four to a line on a small board and at most six on a big one', () => {
    expect(perLineFor(1)).toBe(4);
    expect(perLineFor(12)).toBe(4);
    expect(perLineFor(15)).toBe(5);
    expect(perLineFor(24)).toBe(6);
    expect(perLineFor(60)).toBe(6);
  });
});

describe('bandRows', () => {
  it('starts every band on a line of its own, in band order, wrapping a long one', () => {
    expect(bandRows([['a', 'b'], [], ['c', 'd', 'e', 'f', 'g']], 4)).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e', 'f'],
      ['g'],
    ]);
  });
});

describe('layoutRows', () => {
  it('centres the root on top, every row below it in order, none overlapping', () => {
    for (const [count, perLine, lines] of [
      [3, 4, 1],
      [8, 4, 2],
      [24, 6, 4],
    ] as const) {
      const geometry = layoutRows(ROOT, rowsOf(count, perLine));
      const root = geometry.boxes.get('root')!;

      expect(linesOf(geometry)).toBe(lines);
      expect(root.x + root.width / 2).toBeCloseTo(geometry.width / 2, 5);
      for (const box of geometry.boxes.values()) {
        if (box.id !== 'root') {
          expect(box.y).toBeGreaterThan(root.y + root.height);
        }
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(geometry.width);
      }
      expect(overlaps(geometry)).toEqual([]);
    }
  });

  it('makes each row as tall as its tallest box, with no row borrowing another’s height', () => {
    const geometry = layoutRows(ROOT, [
      [
        { id: 'a', width: 272, height: 120 },
        { id: 'b', width: 272, height: 90 },
      ],
      [{ id: 'c', width: 272, height: 90 }],
    ]);
    const y = (id: string) => geometry.boxes.get(id)!.y;

    expect(y('a')).toBe(y('b'));
    expect(y('c') - y('a')).toBe(120 + 72);
    expect(geometry.height).toBe(y('c') + 90 + 24);
  });

  it('shifts every other row half a box, so it sits under the gaps above', () => {
    const geometry = layoutRows(ROOT, rowsOf(8, 4));
    const x = (id: string) => geometry.boxes.get(id)!.x;
    const step = x('t1') - x('t0');

    expect(x('t4') - x('t0')).toBeCloseTo(step / 2, 5);
  });

  it('routes every wire from the root’s bottom into its box’s top, through no box', () => {
    for (const [count, perLine] of [
      [4, 4],
      [9, 4],
      [24, 6],
    ] as const) {
      const geometry = layoutRows(ROOT, rowsOf(count, perLine));
      const root = geometry.boxes.get('root')!;

      for (const box of itemsOf(count)) {
        const route = geometry.routes.get(box.id)!;
        expect(route[0]).toEqual({
          x: root.x + root.width / 2,
          y: root.y + root.height,
        });
        expect(route.at(-1)!.y).toBe(geometry.boxes.get(box.id)!.y);
      }
      expect(wiresThroughBoxes(geometry)).toEqual([]);
    }
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
    expect(overlaps(geometry)).toEqual([]);
    expect(wiresThroughBoxes(geometry)).toEqual([]);
    expect(geometry.width).toBeLessThanOrEqual(390);
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

describe('layoutRows golden picture', () => {
  it('places equal thread boxes, a mixed-height row and the "+N more" pill exactly as before per-box cells', () => {
    const thread = (id: string, height = 150): GraphBox => ({
      id,
      width: 272,
      height,
    });
    const geometry = layoutRows({ id: 'manager', width: 380, height: 84 }, [
      [thread('a'), thread('b', 182), thread('c')],
      [thread('d'), thread('e')],
      [{ id: 'more', width: 160, height: 32 }],
    ]);
    expect({
      width: geometry.width,
      height: geometry.height,
      boxes: [...geometry.boxes.values()],
      routes: Object.fromEntries(geometry.routes),
    }).toMatchInlineSnapshot(`
      {
        "boxes": [
          {
            "height": 84,
            "id": "manager",
            "width": 380,
            "x": 360,
            "y": 24,
          },
          {
            "height": 150,
            "id": "a",
            "width": 272,
            "x": 24,
            "y": 180,
          },
          {
            "height": 182,
            "id": "b",
            "width": 272,
            "x": 336,
            "y": 180,
          },
          {
            "height": 150,
            "id": "c",
            "width": 272,
            "x": 648,
            "y": 180,
          },
          {
            "height": 150,
            "id": "d",
            "width": 272,
            "x": 336,
            "y": 434,
          },
          {
            "height": 150,
            "id": "e",
            "width": 272,
            "x": 648,
            "y": 434,
          },
          {
            "height": 32,
            "id": "more",
            "width": 160,
            "x": 392,
            "y": 656,
          },
        ],
        "height": 712,
        "routes": {
          "a": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 160,
              "y": 144,
            },
            {
              "x": 160,
              "y": 180,
            },
          ],
          "b": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 472,
              "y": 144,
            },
            {
              "x": 472,
              "y": 180,
            },
          ],
          "c": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 784,
              "y": 144,
            },
            {
              "x": 784,
              "y": 180,
            },
          ],
          "d": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 316,
              "y": 144,
            },
            {
              "x": 316,
              "y": 398,
            },
            {
              "x": 472,
              "y": 398,
            },
            {
              "x": 472,
              "y": 434,
            },
          ],
          "e": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 628,
              "y": 144,
            },
            {
              "x": 628,
              "y": 398,
            },
            {
              "x": 784,
              "y": 398,
            },
            {
              "x": 784,
              "y": 434,
            },
          ],
          "more": [
            {
              "x": 550,
              "y": 108,
            },
            {
              "x": 550,
              "y": 144,
            },
            {
              "x": 316,
              "y": 144,
            },
            {
              "x": 316,
              "y": 398,
            },
            {
              "x": 316,
              "y": 620,
            },
            {
              "x": 472,
              "y": 620,
            },
            {
              "x": 472,
              "y": 656,
            },
          ],
        },
        "width": 1100,
      }
    `);
  });
});

describe('layoutRows per-box cells', () => {
  it('gives a wide box its own width in its row, its neighbours a gap away and every wire into its own centre', () => {
    const geometry = layoutRows(ROOT, [
      [
        { id: 'a', width: 272, height: 150 },
        { id: 'open', width: 480, height: 520 },
        { id: 'c', width: 272, height: 150 },
      ],
      [{ id: 'd', width: 272, height: 150 }],
    ]);
    const a = geometry.boxes.get('a')!;
    const open = geometry.boxes.get('open')!;
    const c = geometry.boxes.get('c')!;
    const d = geometry.boxes.get('d')!;
    expect(open.x - (a.x + a.width)).toBe(40);
    expect(c.x - (open.x + open.width)).toBe(40);
    expect(d.y).toBe(open.y + open.height + 72);
    expect(geometry.routes.get('open')!.at(-1)).toEqual({
      x: open.x + open.width / 2,
      y: open.y,
    });
    expect(overlaps(geometry)).toEqual([]);
    expect(wiresThroughBoxes(geometry)).toEqual([]);
  });
});

describe('layoutRows with pinned boxes', () => {
  const pin = (id: string, x: number, y: number) => new Map([[id, { x, y }]]);

  const offsetFrom = (
    geometry: GraphGeometry,
    id: string,
  ): { x: number; y: number } => {
    const root = geometry.boxes.get('root')!;
    const box = geometry.boxes.get(id)!;
    return { x: box.x - root.x, y: box.y - root.y };
  };

  it('moves a row past every pinned box it would meet, one stacked under another', () => {
    const rows = rowsOf(8, 4);
    const free = layoutRows(ROOT, rows);
    const spot = free.boxes.get('t0')!;
    const root = free.boxes.get('root')!;
    const upper = { x: spot.x - root.x, y: spot.y - root.y };
    const lower = { x: upper.x, y: upper.y + spot.height + 72 };

    const geometry = layoutRows(
      ROOT,
      rows,
      new Map([
        ['t7', upper],
        ['t6', lower],
      ]),
    );

    expect(overlaps(geometry)).toEqual([]);
    const below = geometry.boxes.get('t6')!;
    expect(geometry.boxes.get('t0')!.y).toBeGreaterThanOrEqual(
      below.y + below.height,
    );
  });

  it('keeps the rows under a wholly pinned row where they stood across the canvas', () => {
    const rows = rowsOf(12, 4);
    const free = layoutRows(ROOT, rows);
    const firstRow = new Map(
      rows[0]!.map((box, index) => [box.id, { x: 3000 + index * 400, y: 0 }]),
    );

    const geometry = layoutRows(ROOT, rows, firstRow);

    for (const box of [...rows[1]!, ...rows[2]!]) {
      expect(geometry.boxes.get(box.id)!.x).toBe(free.boxes.get(box.id)!.x);
    }
  });

  it('centres the manager on the frame it is given, however wide a row has grown', () => {
    const rows = rowsOf(8, 4);
    const frame = layoutRows(ROOT, rows).width;
    const grown = rows.map((row, index) =>
      index === 0
        ? row.map((box, at) => (at === 0 ? { ...box, width: 900 } : box))
        : row,
    );

    const geometry = layoutRows(ROOT, grown, new Map(), frame);

    expect(geometry.boxes.get('root')!.x).toBe(frame / 2 - ROOT.width / 2);
    const rightmost = Math.max(
      ...[...geometry.boxes.values()].map((box) => box.x + box.width),
    );
    expect(geometry.width).toBeGreaterThanOrEqual(rightmost);
  });

  it('lays out exactly as before when no box is pinned', () => {
    for (const rows of [rowsOf(9, 4), rowsOf(24, 6)]) {
      expect(layoutRows(ROOT, rows, new Map())).toEqual(layoutRows(ROOT, rows));
    }
  });

  it('stands a pinned box at the manager’s top-left plus its offset', () => {
    const geometry = layoutRows(ROOT, rowsOf(8, 4), pin('t1', 300, 200));
    const root = geometry.boxes.get('root')!;
    const pinned = geometry.boxes.get('t1')!;

    expect(pinned.x).toBe(root.x + 300);
    expect(pinned.y).toBe(root.y + 200);
  });

  it('does not move the manager box when one is pinned, the rows still counting the pinned box', () => {
    const rows = rowsOf(6, 4);
    const free = layoutRows(ROOT, rows);

    const pinned = layoutRows(ROOT, rows, pin('t0', 0, 200));

    expect(pinned.boxes.get('root')).toEqual(free.boxes.get('root'));
    expect(pinned.width).toBe(free.width);
  });

  it('keeps unpinned boxes off a pinned box, a row under it moved below, and the rows in order', () => {
    const rows = rowsOf(8, 4);
    const free = layoutRows(ROOT, rows);
    const spot = free.boxes.get('t0')!;
    const root = free.boxes.get('root')!;

    const geometry = layoutRows(
      ROOT,
      rows,
      pin('t5', spot.x - root.x, spot.y - root.y),
    );

    expect(overlaps(geometry)).toEqual([]);
    const pinnedBox = geometry.boxes.get('t5')!;
    expect(geometry.boxes.get('t0')!.y).toBeGreaterThanOrEqual(
      pinnedBox.y + pinnedBox.height,
    );
    const ys = rows
      .flat()
      .filter((box) => box.id !== 't5')
      .map((box) => geometry.boxes.get(box.id)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('keeps a pinned box the same offset from the manager whatever the width of the rows', () => {
    const offset = { x: 300, y: 200 };

    const narrow = layoutRows(
      ROOT,
      rowsOf(4, 4),
      pin('t1', offset.x, offset.y),
    );
    const wide = layoutRows(ROOT, rowsOf(24, 6), pin('t1', offset.x, offset.y));

    expect(offsetFrom(narrow, 't1')).toEqual(offset);
    expect(offsetFrom(wide, 't1')).toEqual(offset);
    expect(wide.width).toBeGreaterThan(narrow.width);
  });

  it('starts a pinned wire at the manager’s bottom centre and ends it at the top centre of a box below the bus', () => {
    const geometry = layoutRows(ROOT, rowsOf(8, 4), pin('t1', 700, 200));
    const root = geometry.boxes.get('root')!;
    const pinned = geometry.boxes.get('t1')!;
    const route = geometry.routes.get('t1')!;

    expect(route[0]).toEqual({
      x: root.x + root.width / 2,
      y: root.y + root.height,
    });
    expect(route.at(-1)).toEqual({
      x: pinned.x + pinned.width / 2,
      y: pinned.y,
    });
  });

  it('ends a pinned wire at the bottom edge of a box that sits above the bus', () => {
    const geometry = layoutRows(ROOT, rowsOf(8, 4), pin('t1', 700, 0));
    const pinned = geometry.boxes.get('t1')!;

    expect(geometry.routes.get('t1')!.at(-1)).toEqual({
      x: pinned.x + pinned.width / 2,
      y: pinned.y + pinned.height,
    });
  });

  it('grows the graph to take in a pinned box placed far right or far below', () => {
    const right = layoutRows(ROOT, rowsOf(4, 4), pin('t1', 1500, 40));
    const rightBox = right.boxes.get('t1')!;
    expect(right.width).toBe(rightBox.x + rightBox.width + 24);

    const below = layoutRows(ROOT, rowsOf(4, 4), pin('t1', 0, 900));
    const belowBox = below.boxes.get('t1')!;
    expect(below.height).toBe(belowBox.y + belowBox.height + 24);
  });
});
