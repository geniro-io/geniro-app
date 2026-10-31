import { describe, expect, it } from 'vitest';

import { PILL_HEIGHT, stageEdgeKey } from './stage-graph';
import {
  arrowHeadPath,
  layoutStageGraph,
  type Point,
  roundedPath,
  type StageGraphGeometry,
  type StageLink,
} from './stage-graph-layout';

const linksOf = (graph: Record<string, string[]>): StageLink[] =>
  Object.entries(graph).flatMap(([from, nexts]) =>
    nexts.map((to) => ({ key: stageEdgeKey(from, to), from, to })),
  );

const boxesOf = (
  graph: Record<string, string[]>,
  width = 100,
): { id: string; width: number }[] =>
  Object.keys(graph).map((id) => ({ id, width }));

const DEV_TEAM: Record<string, string[]> = {
  triage: ['plan', 'answer'],
  plan: ['build'],
  build: ['agent-review'],
  answer: ['build', 'close-out'],
  'agent-review': ['verification'],
  verification: ['acceptance'],
  acceptance: ['pr-visuals'],
  'pr-visuals': ['close-out'],
  'close-out': [],
};

const columns = (geometry: StageGraphGeometry): string[][] => {
  const out: string[][] = [];
  for (const box of [...geometry.boxes.values()].sort((a, b) => a.y - b.y)) {
    (out[box.column] ??= []).push(box.id);
  }
  return out;
};

function crossesBox(
  a: Point,
  b: Point,
  box: { x: number; y: number; width: number },
): boolean {
  const left = box.x + 1;
  const right = box.x + box.width - 1;
  const top = box.y + 1;
  const bottom = box.y + PILL_HEIGHT - 1;
  const steps = 64;
  for (let step = 0; step <= steps; step += 1) {
    const x = a.x + ((b.x - a.x) * step) / steps;
    const y = a.y + ((b.y - a.y) * step) / steps;
    if (x > left && x < right && y > top && y < bottom) {
      return true;
    }
  }
  return false;
}

describe('layoutStageGraph', () => {
  it('routes every line clear of the pills it does not join, a long skip included', async () => {
    const links = linksOf(DEV_TEAM);
    const geometry = await layoutStageGraph(boxesOf(DEV_TEAM), links);
    const crossings = links.flatMap((link) => {
      const route = geometry.routes.get(link.key)!;
      return [...geometry.boxes.values()]
        .filter((box) => box.id !== link.from && box.id !== link.to)
        .filter((box) =>
          route.some(
            (point, index) =>
              index > 0 && crossesBox(route[index - 1]!, point, box),
          ),
        )
        .map((box) => `${link.key} through ${box.id}`);
    });
    expect(crossings).toEqual([]);
    expect(geometry.routes.get('answer>close-out')!.length).toBeGreaterThan(2);
  });

  it('keeps a fork’s branches in one column between where it splits and joins', async () => {
    const graph = { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] };
    const geometry = await layoutStageGraph(boxesOf(graph), linksOf(graph));
    expect(columns(geometry)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('keeps a loop’s stages in walking order and routes the edge back', async () => {
    const graph = { a: ['b'], b: ['c'], c: ['b', 'd'], d: [] };
    const geometry = await layoutStageGraph(boxesOf(graph), linksOf(graph));
    expect(columns(geometry)).toEqual([['a'], ['b'], ['c'], ['d']]);
    const back = geometry.routes.get('c>b')!;
    expect(back[0]!.x).toBeGreaterThan(back.at(-1)!.x);
  });

  it('routes a stage that names itself', async () => {
    const graph = { a: ['a'] };
    const geometry = await layoutStageGraph(boxesOf(graph), linksOf(graph));
    expect(geometry.routes.get('a>a')!.length).toBeGreaterThan(2);
  });

  describe('given less room than the natural layout', () => {
    const graph = { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] };
    const boxes = [
      { id: 'a', width: 150 },
      { id: 'b', width: 160 },
      { id: 'c', width: 50 },
      { id: 'd', width: 120 },
    ];

    it('tightens the gaps between layers before it cuts any title', async () => {
      const natural = await layoutStageGraph(boxes, linksOf(graph));
      const room = natural.width - 10;
      const fitted = await layoutStageGraph(boxes, linksOf(graph), room);
      expect(fitted.width).toBeLessThanOrEqual(room);
      expect([...fitted.boxes.values()].some((box) => box.cut)).toBe(false);
    });

    it('cuts the widest pills to fit and leaves the short ones whole', async () => {
      const natural = await layoutStageGraph(boxes, linksOf(graph));
      const room = Math.round(natural.width * 0.8);
      const fitted = await layoutStageGraph(boxes, linksOf(graph), room);
      expect(fitted.width).toBeLessThanOrEqual(room);
      expect(fitted.boxes.get('b')!.cut).toBe(true);
      expect(fitted.boxes.get('c')!.cut).toBe(false);
      expect(fitted.boxes.get('c')!.width).toBe(50);
      expect([...natural.boxes.values()].some((box) => box.cut)).toBe(false);
    });

    it('stops at a readable floor and overflows when even that cannot fit', async () => {
      const fitted = await layoutStageGraph(boxes, linksOf(graph), 60);
      expect(fitted.width).toBeGreaterThan(60);
      expect(
        Math.min(...[...fitted.boxes.values()].map((box) => box.width)),
      ).toBe(50);
      expect(fitted.boxes.get('a')!.width).toBe(56);
    });
  });
});

describe('roundedPath', () => {
  it('rounds each corner and ends on the last point', () => {
    const path = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ],
      6,
    );
    expect(path).toBe('M 0 0 L 14 0 Q 20 0 20 6 L 20 20');
  });
});

describe('arrowHeadPath', () => {
  it('points along the last leg with its tip on the end', () => {
    expect(
      arrowHeadPath(
        [
          { x: 0, y: 10 },
          { x: 20, y: 10 },
        ],
        4,
      ),
    ).toBe('M 16 14 L 20 10 L 16 6');
  });
});
