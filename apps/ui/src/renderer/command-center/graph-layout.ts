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

/** One project's threads, laid out as one framed block. */
export interface LayoutBlock {
  id: string;
  /** The block's threads in the order they stand, reading order. */
  items: readonly GraphBox[];
  /** A box on a line of its own under the items (the "+N more" of threads left off the graph); it is never pinned and has no wire. */
  footer?: GraphBox;
}

export const BLOCK_HEAD = 40;
export const BLOCK_PAD = 16;
const BLOCK_GAP = 24;

interface BlockShape {
  id: string;
  width: number;
  height: number;
  /** Each free item's place from the block's top-left. */
  items: { box: GraphBox; x: number; y: number }[];
}

/** A block's frame around its free items, at most `columns` to a line, each line as tall as its tallest item. */
function shapeOf(
  block: LayoutBlock,
  free: readonly GraphBox[],
  columns: number,
): BlockShape {
  const items: BlockShape['items'] = [];
  let y = BLOCK_HEAD;
  let width = 0;
  for (let start = 0; start < free.length; start += columns) {
    const line = free.slice(start, start + columns);
    let x = BLOCK_PAD;
    for (const box of line) {
      items.push({ box, x, y });
      x += box.width + BLOCK_GAP;
    }
    width = Math.max(width, x - BLOCK_GAP + BLOCK_PAD);
    y += Math.max(...line.map((box) => box.height)) + BLOCK_GAP;
  }
  if (block.footer !== undefined) {
    items.push({ box: block.footer, x: BLOCK_PAD, y });
    width = Math.max(width, block.footer.width + BLOCK_PAD * 2);
    y += block.footer.height + BLOCK_GAP;
  }
  return {
    id: block.id,
    width: Math.max(width, MIN_BLOCK_WIDTH),
    height: y - BLOCK_GAP + BLOCK_PAD,
    items,
  };
}

const MIN_BLOCK_WIDTH = 220;

/**
 * The root centred on top and the project blocks under it, left to right in
 * the order given, a line wrapping once it is `perLine` cards wide; each line
 * is centred under the root and as tall as its tallest block. Inside a block
 * its items stand in reading order, at most `perLine` to a line, its footer
 * on a line of its own under them.
 *
 * An item in `pinned` stands at the root's top-left plus its offset instead,
 * out of its block, which shrinks around the rest from its own top-left; every
 * block keeps the place it has with nothing pinned, and only a block a pinned
 * box would touch moves along its line to the next free place past it — so a
 * pin moves only what it overlaps. The root is centred on `frame` when given (the
 * width with every card closed and none pinned), so neither a pin nor a card
 * grown in place moves the root and with it every pinned box.
 *
 * One wire runs from the root to each block's top and to each pinned box; a
 * wire to a lower line passes each line above it through the nearest gap.
 */
export function layoutBlocks(
  root: GraphBox,
  blocks: readonly LayoutBlock[],
  perLine: number,
  pinned: ReadonlyMap<string, Point> = new Map(),
  frame?: number,
): GraphGeometry {
  const filled = blocks.filter(
    (block) => block.items.length > 0 || block.footer !== undefined,
  );
  const cell = Math.max(
    0,
    ...filled.flatMap((block) => block.items.map((item) => item.width)),
  );
  const columns = Math.max(1, perLine);
  const lineRoom = columns * (cell + BLOCK_PAD * 2 + COLUMN_GAP);
  const natural = new Map(
    filled.map((block) => [block.id, shapeOf(block, block.items, columns)]),
  );
  const shapes = new Map(
    filled.map((block) => [
      block.id,
      shapeOf(
        block,
        block.items.filter((item) => !pinned.has(item.id)),
        columns,
      ),
    ]),
  );
  const lines: BlockShape[][] = [];
  for (const shape of natural.values()) {
    const line = lines.at(-1);
    const span =
      line === undefined
        ? Infinity
        : line.reduce((sum, item) => sum + item.width + COLUMN_GAP, 0) +
          shape.width;
    if (line === undefined || span > lineRoom) {
      lines.push([shape]);
    } else {
      line.push(shape);
    }
  }
  const spanOf = (line: readonly BlockShape[]): number =>
    line.reduce((sum, shape) => sum + shape.width, 0) +
    COLUMN_GAP * (line.length - 1);
  const widest = Math.max(0, ...lines.map(spanOf));
  const width = frame ?? Math.max(widest, root.width) + MARGIN * 2;
  const centre = width / 2;

  const boxes = new Map<string, PlacedBox>();
  const routes = new Map<string, Point[]>();
  const placedRoot = { ...root, x: centre - root.width / 2, y: MARGIN };
  boxes.set(root.id, placedRoot);
  const rootBottom = MARGIN + root.height;

  const obstacles: PlacedBox[] = [];
  for (const item of filled.flatMap((block) => block.items)) {
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
  const placedLines: PlacedBox[][] = [];
  for (const line of lines) {
    let left = centre - spanOf(line) / 2;
    const slots = line.flatMap((slot) => {
      const shape = shapes.get(slot.id);
      const x = left;
      left += slot.width + COLUMN_GAP;
      return shape === undefined || shape.items.length === 0
        ? []
        : [
            {
              shape,
              box: {
                id: shape.id,
                width: shape.width,
                height: shape.height,
                x,
                y: top,
              },
            },
          ];
    });
    if (slots.length === 0) {
      continue;
    }
    const placed: PlacedBox[] = [];
    const displaced: PlacedBox[] = [];
    for (const { box } of slots) {
      (obstacles.some((obstacle) => overlaps(box, obstacle))
        ? displaced
        : placed
      ).push(box);
    }
    for (const start of displaced) {
      let box = start;
      for (;;) {
        const hit = [...obstacles, ...placed].filter((other) =>
          overlaps(box, other),
        );
        if (hit.length === 0) {
          break;
        }
        box = {
          ...box,
          x:
            Math.max(...hit.map((other) => other.x + other.width)) + COLUMN_GAP,
        };
      }
      placed.push(box);
    }
    for (const box of placed) {
      boxes.set(box.id, box);
      for (const item of shapes.get(box.id)!.items) {
        boxes.set(item.box.id, {
          ...item.box,
          x: box.x + item.x,
          y: box.y + item.y,
        });
      }
    }
    placed.sort((a, b) => a.x - b.x);
    placedLines.push(placed);
    top = Math.max(...placed.map((box) => box.y + box.height)) + LINE_GAP;
  }

  placedLines.forEach((line, lineIndex) => {
    for (const box of line) {
      const target = box.x + box.width / 2;
      const points: Point[] = [{ x: centre, y: rootBottom }];
      let x = centre;
      for (let above = 0; above < lineIndex; above += 1) {
        const bus = placedLines[above]![0]!.y - LINE_GAP / 2;
        const passage = passageNear(placedLines[above]!, target);
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
  const lowest = Math.max(
    rootBottom,
    ...placedBoxes.map((b) => b.y + b.height),
  );
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
 * edge and turning into each box. A box in `unwired` (a project's name over
 * its threads, its "+N more") stands in the column with no wire.
 */
export function layoutColumn(
  root: GraphBox,
  items: readonly GraphBox[],
  unwired: ReadonlySet<string> = new Set(),
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
    if (unwired.has(item.id)) {
      continue;
    }
    const middle = placed.y + Math.min(placed.height / 2, 28);
    routes.set(item.id, [
      { x: spine, y: top.y + top.height },
      { x: spine, y: middle },
      { x: placed.x, y: middle },
    ]);
  }
  return { width, height: y - STACK_GAP + MARGIN, boxes, routes };
}
