import { describe, expect, it } from 'vitest';

import {
  type GraphBox,
  type GraphGeometry,
  layoutColumn,
  layoutLines,
  linesFor,
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

describe('linesFor', () => {
  it('stands a few threads in one line, a handful in two and more in three', () => {
    expect(linesFor(1)).toBe(1);
    expect(linesFor(4)).toBe(1);
    expect(linesFor(5)).toBe(2);
    expect(linesFor(10)).toBe(2);
    expect(linesFor(11)).toBe(3);
    expect(linesFor(25)).toBe(3);
  });
});

describe('layoutLines', () => {
  it('centres the root on top, every item below it, in the lines asked for, none overlapping', () => {
    for (const [count, lines] of [
      [3, 1],
      [8, 2],
      [25, 3],
    ] as const) {
      const geometry = layoutLines(ROOT, itemsOf(count), lines);
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

  it('shifts every other line half a box, so it sits under the gaps above', () => {
    const geometry = layoutLines(ROOT, itemsOf(8), 2);
    const x = (id: string) => geometry.boxes.get(id)!.x;
    const step = x('t1') - x('t0');

    expect(x('t4') - x('t0')).toBeCloseTo(step / 2, 5);
  });

  it('routes every wire from the root’s bottom into its box’s top, through no box', () => {
    for (const [count, lines] of [
      [4, 1],
      [9, 2],
      [24, 3],
    ] as const) {
      const geometry = layoutLines(ROOT, itemsOf(count), lines);
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
