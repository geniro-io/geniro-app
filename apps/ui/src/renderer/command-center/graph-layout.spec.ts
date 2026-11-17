import { describe, expect, it } from 'vitest';

import {
  columnsFor,
  type GraphBox,
  type GraphGeometry,
  type GraphItem,
  layoutColumn,
  layoutRows,
} from './graph-layout';

const ROOT: GraphBox = { id: 'root', width: 300, height: 64 };

function itemsOf(count: number, childAt: number[] = []): GraphItem[] {
  return Array.from({ length: count }, (_, index) => ({
    box: { id: `t${index}`, width: 300, height: 120 + (index % 3) * 20 },
    child: childAt.includes(index)
      ? { id: `c${index}`, width: 260, height: 60 }
      : null,
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

/** Does any straight segment of a wire pass through a box other than its own ends? */
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
        const left = Math.min(a.x, b.x);
        const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y);
        const bottom = Math.max(a.y, b.y);
        if (
          left < box.x + box.width - 1 &&
          right > box.x + 1 &&
          top < box.y + box.height - 1 &&
          bottom > box.y + 1
        ) {
          hits.push(`${id} through ${box.id}`);
        }
      }
    }
  }
  return hits;
}

describe('columnsFor', () => {
  it('fits as many cards a row as stay readable when fitted, at most six', () => {
    expect(columnsFor(1200, 300, 13)).toBe(4);
    expect(columnsFor(4000, 300, 24)).toBe(6);
    expect(columnsFor(1200, 300, 2)).toBe(2);
    expect(columnsFor(0, 300, 13)).toBe(1);
  });
});

describe('layoutRows', () => {
  it('puts the root on top, centred over the rows, and every item below it', () => {
    const geometry = layoutRows(ROOT, itemsOf(5), 3);
    const root = geometry.boxes.get('root')!;
    const firstRow = ['t0', 't1', 't2'].map((id) => geometry.boxes.get(id)!);

    for (const box of [...geometry.boxes.values()].filter(
      (one) => one.id !== 'root',
    )) {
      expect(box.y).toBeGreaterThan(root.y + root.height);
    }
    const rowCentre =
      (firstRow[0]!.x + firstRow[2]!.x + firstRow[2]!.width) / 2;
    expect(root.x + root.width / 2).toBeCloseTo(rowCentre, 5);
  });

  it('wraps the items into rows of the given width, in order, none overlapping', () => {
    const geometry = layoutRows(ROOT, itemsOf(7, [1, 5]), 3);
    const y = (id: string) => geometry.boxes.get(id)!.y;
    const x = (id: string) => geometry.boxes.get(id)!.x;

    expect(new Set([y('t0'), y('t1'), y('t2')]).size).toBe(1);
    expect(y('t3')).toBeGreaterThan(y('t0'));
    expect(y('t6')).toBeGreaterThan(y('t3'));
    expect(x('t0')).toBeLessThan(x('t1'));
    expect(x('t3')).toBe(x('t0'));
    expect(overlaps(geometry)).toEqual([]);
  });

  it('hangs a child under its item, and starts the next row below the child', () => {
    const geometry = layoutRows(ROOT, itemsOf(4, [0]), 3);
    const item = geometry.boxes.get('t0')!;
    const child = geometry.boxes.get('c0')!;

    expect(child.y).toBeGreaterThan(item.y + item.height);
    expect(child.x + child.width / 2).toBeCloseTo(item.x + item.width / 2, 5);
    expect(geometry.boxes.get('t3')!.y).toBeGreaterThan(child.y + child.height);
  });

  it('routes every wire from the root’s bottom down into its item’s top, through no box', () => {
    const geometry = layoutRows(ROOT, itemsOf(8, [2, 4]), 3);
    const root = geometry.boxes.get('root')!;

    for (const id of ['t0', 't4', 't7']) {
      const route = geometry.routes.get(id)!;
      expect(route[0]!.y).toBe(root.y + root.height);
      expect(route.at(-1)!.y).toBe(geometry.boxes.get(id)!.y);
    }
    expect(wiresThroughBoxes(geometry)).toEqual([]);
  });
});

describe('layoutColumn', () => {
  it('stacks every box in one column, in order, each level indented, none overlapping, phone-wide', () => {
    const geometry = layoutColumn(ROOT, itemsOf(3, [0]));
    const at = (id: string) => geometry.boxes.get(id)!;

    expect(
      [...geometry.boxes.values()].sort((a, b) => a.y - b.y).map((b) => b.id),
    ).toEqual(['root', 't0', 'c0', 't1', 't2']);
    expect(at('t0').x).toBeGreaterThan(at('root').x);
    expect(at('c0').x).toBeGreaterThan(at('t0').x);
    expect(at('t1').x).toBe(at('t0').x);
    expect(overlaps(geometry)).toEqual([]);
    expect(geometry.width).toBeLessThanOrEqual(390);
  });

  it('runs each wire down its parent’s left edge and turns it into the box', () => {
    const geometry = layoutColumn(ROOT, itemsOf(3));
    const route = geometry.routes.get('t2')!;
    const root = geometry.boxes.get('root')!;
    const box = geometry.boxes.get('t2')!;

    expect(route[0]).toEqual({ x: route[1]!.x, y: root.y + root.height });
    expect(route.at(-1)!.x).toBe(box.x);
    expect(route.at(-1)!.y).toBeGreaterThan(box.y);
    expect(route.at(-1)!.y).toBeLessThan(box.y + box.height);
    expect(wiresThroughBoxes(geometry)).toEqual([]);
  });
});
