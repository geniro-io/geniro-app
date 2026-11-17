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

/** How many lines the items stand in: one for a few, two for a handful, three past that. */
export function linesFor(count: number): number {
  if (count <= 4) {
    return 1;
  }
  return count <= 10 ? 2 : 3;
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

/**
 * The root centred on top and the items under it in `lines` horizontal lines
 * of equal count, every other line shifted half a box so it sits under the
 * gaps of the line above. A wire leaves the root's bottom, runs along the gap
 * above the first line, passes each line above its own through the nearest
 * gap, and drops into its box's top — so no wire crosses a box.
 */
export function layoutLines(
  root: GraphBox,
  items: readonly GraphBox[],
  lines: number,
): GraphGeometry {
  const cell = Math.max(0, ...items.map((item) => item.width));
  const height = Math.max(0, ...items.map((item) => item.height));
  const perLine = Math.max(1, Math.ceil(items.length / Math.max(1, lines)));
  const rows: GraphBox[][] = [];
  for (let start = 0; start < items.length; start += perLine) {
    rows.push(items.slice(start, start + perLine));
  }
  const step = cell + COLUMN_GAP;
  const stagger = rows.length > 1 ? step / 2 : 0;
  const widest =
    Math.max(0, ...rows.map((row) => row.length * step - COLUMN_GAP)) + stagger;
  const width = Math.max(widest, root.width) + MARGIN * 2;
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

  const placedRows: PlacedBox[][] = rows.map((row, index) => {
    const top = rootBottom + LINE_GAP + index * (height + LINE_GAP);
    const span = row.length * step - COLUMN_GAP;
    const left =
      centre - span / 2 + (index % 2 === 1 ? stagger / 2 : -stagger / 2);
    return row.map((item, column) => {
      const placed = {
        ...item,
        x: left + column * step + (cell - item.width) / 2,
        y: top,
      };
      boxes.set(item.id, placed);
      return placed;
    });
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

  const bottom =
    placedRows.length === 0 ? rootBottom : placedRows.at(-1)![0]!.y + height;
  return { width, height: bottom + MARGIN, boxes, routes };
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
