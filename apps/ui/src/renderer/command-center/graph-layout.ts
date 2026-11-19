import type { Point } from '../components/stage-graph-layout';

export interface GraphBox {
  id: string;
  width: number;
  height: number;
}

export interface PlacedBox extends GraphBox {
  x: number;
  y: number;
}

export interface GraphGeometry {
  width: number;
  height: number;
  boxes: ReadonlyMap<string, PlacedBox>;
  /** Keyed by the lower box's id: the wire from the root down to it. */
  routes: ReadonlyMap<string, readonly Point[]>;
}

const MARGIN = 24;
const COLUMN_GAP = 40;
const LINE_GAP = 72;

const INDENT = 28;
const STACK_GAP = 16;
const STUB = 14;

/** The zoom a card stays readable at, which caps how many stand in a line of a narrow canvas. */
const READABLE_ZOOM = 0.8;

/**
 * The most cards a line holds: four to six by how many there are, and no more
 * than `cardWidth` cards fit a `canvasWidth` canvas at a readable zoom (0 when
 * not measured), never under one.
 */
export function perLineFor(
  count: number,
  canvasWidth = 0,
  cardWidth = 0,
): number {
  const byCount = Math.min(6, Math.max(4, Math.ceil(count / 3)));
  if (canvasWidth <= 0 || cardWidth <= 0) {
    return byCount;
  }
  const step = cardWidth + COLUMN_GAP;
  const room = canvasWidth / READABLE_ZOOM - MARGIN * 2 - step / 2;
  const fits = Math.floor((room + COLUMN_GAP) / step);
  return Math.max(1, Math.min(byCount, fits));
}

/** Each band on lines of its own, in band order, a band longer than `perLine` wrapped. */
export function bandRows<T>(
  bands: readonly (readonly T[])[],
  perLine: number,
): T[][] {
  const rows: T[][] = [];
  for (const band of bands) {
    for (let start = 0; start < band.length; start += perLine) {
      rows.push(band.slice(start, start + perLine));
    }
  }
  return rows;
}

function withoutRepeats(points: readonly Point[]): Point[] {
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1]!.x ||
      point.y !== points[index - 1]!.y,
  );
}

/** The x a wire may pass a line at nearest to `target`: a gap between two boxes, or beside the line. */
function passageNear(line: readonly PlacedBox[], target: number): number {
  const first = line[0]!;
  const last = line.at(-1)!;
  const passages = [
    first.x - COLUMN_GAP / 2,
    ...line
      .slice(1)
      .map((box, index) => (line[index]!.x + line[index]!.width + box.x) / 2),
    last.x + last.width + COLUMN_GAP / 2,
  ];
  return passages.reduce((best, x) =>
    Math.abs(x - target) < Math.abs(best - target) ? x : best,
  );
}

function overlaps(box: PlacedBox, obstacle: PlacedBox): boolean {
  return (
    box.x < obstacle.x + obstacle.width + COLUMN_GAP / 2 &&
    obstacle.x < box.x + box.width + COLUMN_GAP / 2 &&
    box.y < obstacle.y + obstacle.height + LINE_GAP / 2 &&
    obstacle.y < box.y + box.height + LINE_GAP / 2
  );
}

/**
 * The root centred on top and the rows under it, each centred and every
 * other one shifted half the widest box so it sits under the gaps of the row
 * above. Each box takes its own width in its row, and a row is as tall as its
 * tallest box. A wire leaves the root's bottom, runs
 * along the gap above the first row, passes each row above its own through
 * the nearest gap, and drops into its box's top — so no wire crosses a box.
 *
 * A box in `pinned` stands at the root's top-left plus its offset instead, and
 * a row that would touch it moves down past it. The width the root is centred
 * on still counts pinned boxes in their rows, and `frame`, when given, replaces
 * it, so neither a pin nor a box grown in place moves the root and with it
 * every pinned box.
 */
export function layoutRows(
  root: GraphBox,
  rows: readonly (readonly GraphBox[])[],
  pinned: ReadonlyMap<string, Point> = new Map(),
  frame?: number,
): GraphGeometry {
  const filled = rows.filter((row) => row.length > 0);
  const cell = Math.max(0, ...filled.flat().map((item) => item.width));
  const stagger = filled.length > 1 ? (cell + COLUMN_GAP) / 2 : 0;
  const spanOf = (row: readonly GraphBox[]): number =>
    row.reduce((sum, item) => sum + item.width, 0) +
    COLUMN_GAP * (row.length - 1);
  const widest = Math.max(0, ...filled.map(spanOf)) + stagger;
  const width = frame ?? Math.max(widest, root.width) + MARGIN * 2;
  const centre = width / 2;

  const boxes = new Map<string, PlacedBox>();
  const routes = new Map<string, Point[]>();
  const placedRoot = {
    ...root,
    x: centre - root.width / 2,
    y: MARGIN,
  };
  boxes.set(root.id, placedRoot);
  const rootBottom = MARGIN + root.height;

  const obstacles: PlacedBox[] = [];
  for (const item of filled.flat()) {
    const offset = pinned.get(item.id);
    if (offset !== undefined) {
      const placed = {
        ...item,
        x: placedRoot.x + offset.x,
        y: placedRoot.y + offset.y,
      };
      boxes.set(item.id, placed);
      obstacles.push(placed);
    }
  }

  let top = rootBottom + LINE_GAP;
  let bottom = rootBottom;
  const placedRows: PlacedBox[][] = [];
  filled.forEach((row, rowIndex) => {
    const free = row.filter((item) => !pinned.has(item.id));
    if (free.length === 0) {
      return;
    }
    const start =
      centre -
      spanOf(free) / 2 +
      (rowIndex % 2 === 1 ? stagger / 2 : -stagger / 2);
    const at = (rowTop: number): PlacedBox[] => {
      let x = start;
      return free.map((item) => {
        const placed = { ...item, x, y: rowTop };
        x += item.width + COLUMN_GAP;
        return placed;
      });
    };
    let placed = at(top);
    for (;;) {
      const hit = obstacles.filter((obstacle) =>
        placed.some((box) => overlaps(box, obstacle)),
      );
      if (hit.length === 0) {
        break;
      }
      placed = at(
        Math.max(...hit.map((obstacle) => obstacle.y + obstacle.height)) +
          LINE_GAP,
      );
    }
    const rowTop = placed[0]!.y;
    const tallest = Math.max(...free.map((item) => item.height));
    top = rowTop + tallest + LINE_GAP;
    bottom = rowTop + tallest;
    for (const box of placed) {
      boxes.set(box.id, box);
    }
    placedRows.push(placed);
  });

  placedRows.forEach((row, lineIndex) => {
    for (const box of row) {
      const target = box.x + box.width / 2;
      const points: Point[] = [{ x: centre, y: rootBottom }];
      let x = centre;
      for (let above = 0; above < lineIndex; above += 1) {
        const bus = placedRows[above]![0]!.y - LINE_GAP / 2;
        const passage = passageNear(placedRows[above]!, target);
        points.push({ x, y: bus }, { x: passage, y: bus });
        x = passage;
      }
      const bus = box.y - LINE_GAP / 2;
      points.push(
        { x, y: bus },
        { x: target, y: bus },
        { x: target, y: box.y },
      );
      routes.set(box.id, withoutRepeats(points));
    }
  });

  const bus = rootBottom + LINE_GAP / 2;
  for (const box of obstacles) {
    const target = box.x + box.width / 2;
    const end = box.y >= bus ? box.y : box.y + box.height;
    routes.set(
      box.id,
      withoutRepeats([
        { x: centre, y: rootBottom },
        { x: centre, y: bus },
        { x: target, y: bus },
        { x: target, y: end },
      ]),
    );
  }

  const placedBoxes = [...boxes.values()];
  const right = Math.max(
    width - MARGIN,
    ...placedBoxes.map((b) => b.x + b.width),
  );
  const lowest = Math.max(bottom, ...obstacles.map((b) => b.y + b.height));
  return {
    width: right + MARGIN,
    height: lowest + MARGIN,
    boxes,
    routes,
  };
}

/**
 * The same tree as one column, for a narrow screen: the root on top, every
 * item below it in order, indented, and a wire running down the root's left
 * edge and turning into each box.
 */
export function layoutColumn(
  root: GraphBox,
  items: readonly GraphBox[],
): GraphGeometry {
  const boxes = new Map<string, PlacedBox>();
  const routes = new Map<string, Point[]>();
  let y = MARGIN;
  let width = 0;
  const place = (box: GraphBox, x: number): PlacedBox => {
    const placed = { ...box, x, y };
    boxes.set(box.id, placed);
    y += box.height + STACK_GAP;
    width = Math.max(width, x + box.width + MARGIN);
    return placed;
  };
  const top = place(root, MARGIN);
  const spine = top.x + STUB;
  for (const item of items) {
    const placed = place(item, MARGIN + INDENT);
    const middle = placed.y + Math.min(placed.height / 2, 28);
    routes.set(item.id, [
      { x: spine, y: top.y + top.height },
      { x: spine, y: middle },
      { x: placed.x, y: middle },
    ]);
  }
  return { width, height: y - STACK_GAP + MARGIN, boxes, routes };
}
