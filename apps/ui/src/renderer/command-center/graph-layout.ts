import type { Point } from '../components/stage-graph-layout';

export interface GraphBox {
  id: string;
  width: number;
  height: number;
}

/** One box under the root, and the box folded under it, if any. */
export interface GraphItem {
  box: GraphBox;
  child: GraphBox | null;
}

export interface PlacedBox extends GraphBox {
  x: number;
  y: number;
}

export interface GraphGeometry {
  width: number;
  height: number;
  boxes: ReadonlyMap<string, PlacedBox>;
  /** Keyed by the lower box's id: the wire from the box above down to it. */
  routes: ReadonlyMap<string, readonly Point[]>;
}

const MARGIN = 24;
const SPINE_ROOM = 24;
const COLUMN_GAP = 32;
const ROW_GAP = 72;
const CHILD_GAP = 36;
const MAX_COLUMNS = 6;
/** The smallest zoom a fitted row should need, so a card stays readable. */
const READABLE_ZOOM = 0.8;

const INDENT = 28;
const STACK_GAP = 16;
const STUB = 14;

/** How many cards a row holds in a canvas this wide, so the fitted graph stays readable. */
export function columnsFor(
  canvasWidth: number,
  cardWidth: number,
  count: number,
): number {
  const fits = Math.floor(
    (canvasWidth / READABLE_ZOOM - MARGIN * 2 - SPINE_ROOM + COLUMN_GAP) /
      (cardWidth + COLUMN_GAP),
  );
  return Math.max(1, Math.min(count, MAX_COLUMNS, fits));
}

function withoutRepeats(points: readonly Point[]): Point[] {
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1]!.x ||
      point.y !== points[index - 1]!.y,
  );
}

/**
 * The root centred on top and its items in rows of `columns` under it, each
 * item's child under the item. A wire leaves the root's bottom, runs along a
 * bus in the gap above the first row, down a spine left of the rows to the bus
 * above its own row, and drops into the item's top — so no wire crosses a box.
 */
export function layoutRows(
  root: GraphBox,
  items: readonly GraphItem[],
  columns: number,
): GraphGeometry {
  const cell = Math.max(0, ...items.map((item) => item.box.width));
  const perRow = Math.max(1, columns);
  const gridLeft = MARGIN + SPINE_ROOM;
  const used = Math.min(perRow, items.length);
  const gridWidth = Math.max(0, used * cell + (used - 1) * COLUMN_GAP);
  const boxes = new Map<string, PlacedBox>();
  const routes = new Map<string, Point[]>();

  const rootX = gridLeft + Math.max(0, (gridWidth - root.width) / 2);
  boxes.set(root.id, { ...root, x: rootX, y: MARGIN });
  const rootBottom = MARGIN + root.height;
  const trunkX = rootX + root.width / 2;
  const spineX = MARGIN + SPINE_ROOM / 2;
  const firstBus = rootBottom + ROW_GAP / 2;

  let rowTop = rootBottom + ROW_GAP;
  for (let start = 0; start < items.length; start += perRow) {
    const row = items.slice(start, start + perRow);
    const bus = rowTop - ROW_GAP / 2;
    let rowHeight = 0;
    row.forEach((item, column) => {
      const cellLeft = gridLeft + column * (cell + COLUMN_GAP);
      const x = cellLeft + (cell - item.box.width) / 2;
      boxes.set(item.box.id, { ...item.box, x, y: rowTop });
      const centre = x + item.box.width / 2;
      routes.set(
        item.box.id,
        withoutRepeats(
          start === 0
            ? [
                { x: trunkX, y: rootBottom },
                { x: trunkX, y: firstBus },
                { x: centre, y: firstBus },
                { x: centre, y: rowTop },
              ]
            : [
                { x: trunkX, y: rootBottom },
                { x: trunkX, y: firstBus },
                { x: spineX, y: firstBus },
                { x: spineX, y: bus },
                { x: centre, y: bus },
                { x: centre, y: rowTop },
              ],
        ),
      );
      let height = item.box.height;
      if (item.child !== null) {
        const childTop = rowTop + item.box.height + CHILD_GAP;
        boxes.set(item.child.id, {
          ...item.child,
          x: cellLeft + (cell - item.child.width) / 2,
          y: childTop,
        });
        routes.set(item.child.id, [
          { x: centre, y: rowTop + item.box.height },
          { x: centre, y: childTop },
        ]);
        height += CHILD_GAP + item.child.height;
      }
      rowHeight = Math.max(rowHeight, height);
    });
    rowTop += rowHeight + ROW_GAP;
  }

  return {
    width: gridLeft + Math.max(gridWidth, root.width) + MARGIN,
    height: (items.length === 0 ? rootBottom : rowTop - ROW_GAP) + MARGIN,
    boxes,
    routes,
  };
}

/**
 * The same tree as one column, for a narrow screen: the root on top, every
 * item below it in order and its child under it, each level indented, and a
 * wire running down the parent's left edge and turning into each box.
 */
export function layoutColumn(
  root: GraphBox,
  items: readonly GraphItem[],
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
  const turnInto = (parent: PlacedBox, child: PlacedBox): Point[] => {
    const spine = parent.x + STUB;
    const middle = child.y + Math.min(child.height / 2, 28);
    return [
      { x: spine, y: parent.y + parent.height },
      { x: spine, y: middle },
      { x: child.x, y: middle },
    ];
  };
  const top = place(root, MARGIN);
  for (const item of items) {
    const placed = place(item.box, MARGIN + INDENT);
    routes.set(item.box.id, turnInto(top, placed));
    if (item.child !== null) {
      const child = place(item.child, MARGIN + INDENT * 2);
      routes.set(item.child.id, turnInto(placed, child));
    }
  }
  return { width, height: y - STACK_GAP + MARGIN, boxes, routes };
}
