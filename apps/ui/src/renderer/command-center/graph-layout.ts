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
 * A block in `placed` stands at the root's top-left plus its offset, out of
 * its line, wired from the root like a pinned box; the blocks of its line keep
 * their places and only one it would touch moves, as for a pinned box.
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
  placed: ReadonlyMap<string, Point> = new Map(),
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

  const setBlock = (box: PlacedBox): void => {
    boxes.set(box.id, box);
    for (const item of shapes.get(box.id)!.items) {
      boxes.set(item.box.id, {
        ...item.box,
        x: box.x + item.x,
        y: box.y + item.y,
      });
    }
  };

  const obstacles: PlacedBox[] = [];
  const placedBlocks: PlacedBox[] = [];
  for (const shape of shapes.values()) {
    const offset = placed.get(shape.id);
    if (offset !== undefined && shape.items.length > 0) {
      placedBlocks.push({
        id: shape.id,
        width: shape.width,
        height: shape.height,
        x: placedRoot.x + offset.x,
        y: placedRoot.y + offset.y,
      });
    }
  }
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
      return shape === undefined ||
        shape.items.length === 0 ||
        placed.has(shape.id)
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
    const held = line.flatMap((slot) => {
      const shape = shapes.get(slot.id);
      return shape !== undefined &&
        shape.items.length > 0 &&
        placed.has(shape.id)
        ? [top + shape.height]
        : [];
    });
    if (slots.length === 0) {
      if (held.length > 0) {
        top = Math.max(...held) + LINE_GAP;
      }
      continue;
    }
    const fixed = [...obstacles, ...placedBlocks];
    const inLine: PlacedBox[] = [];
    const displaced: PlacedBox[] = [];
    for (const { box } of slots) {
      (fixed.some((obstacle) => overlaps(box, obstacle))
        ? displaced
        : inLine
      ).push(box);
    }
    for (const start of displaced) {
      let box = start;
      for (;;) {
        const hit = [...fixed, ...inLine].filter((other) =>
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
      inLine.push(box);
    }
    inLine.forEach(setBlock);
    inLine.sort((a, b) => a.x - b.x);
    placedLines.push(inLine);
    top =
      Math.max(...inLine.map((box) => box.y + box.height), ...held) + LINE_GAP;
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

  for (const box of [...obstacles, ...placedBlocks]) {
    routes.set(box.id, elbowFrom(placedRoot, box));
  }
  placedBlocks.forEach(setBlock);

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

/** A pinned box's own wire: down from the root's bottom centre, along the bus under it, into the box's nearer edge. */
function elbowFrom(root: PlacedBox, box: PlacedBox): Point[] {
  const centre = root.x + root.width / 2;
  const rootBottom = root.y + root.height;
  const bus = rootBottom + LINE_GAP / 2;
  const target = box.x + box.width / 2;
  const end = box.y >= bus ? box.y : box.y + box.height;
  return withoutRepeats([
    { x: centre, y: rootBottom },
    { x: centre, y: bus },
    { x: target, y: bus },
    { x: target, y: end },
  ]);
}

/**
 * `geometry` with one box standing at the root's top-left plus `offset` and
 * wired as a pinned box, everything else where it was: a box being dragged,
 * which lays nothing out again until it is dropped.
 */
export function withBoxAt(
  geometry: GraphGeometry,
  rootId: string,
  id: string,
  offset: Point,
): GraphGeometry {
  const root = geometry.boxes.get(rootId);
  const box = geometry.boxes.get(id);
  if (root === undefined || box === undefined) {
    return geometry;
  }
  const moved = { ...box, x: root.x + offset.x, y: root.y + offset.y };
  return {
    ...geometry,
    boxes: new Map(geometry.boxes).set(id, moved),
    routes: new Map(geometry.routes).set(id, elbowFrom(root, moved)),
  };
}

/**
 * `geometry` with one block, and every box in `members` with it, standing at
 * the root's top-left plus `offset` and wired as a pinned box, everything else
 * where it was: a block being dragged.
 */
export function withBlockAt(
  geometry: GraphGeometry,
  rootId: string,
  blockId: string,
  members: readonly string[],
  offset: Point,
): GraphGeometry {
  const root = geometry.boxes.get(rootId);
  const block = geometry.boxes.get(blockId);
  if (root === undefined || block === undefined) {
    return geometry;
  }
  const dx = root.x + offset.x - block.x;
  const dy = root.y + offset.y - block.y;
  const boxes = new Map(geometry.boxes);
  for (const id of [blockId, ...members]) {
    const box = boxes.get(id);
    if (box !== undefined) {
      boxes.set(id, { ...box, x: box.x + dx, y: box.y + dy });
    }
  }
  return {
    ...geometry,
    boxes,
    routes: new Map(geometry.routes).set(
      blockId,
      elbowFrom(root, boxes.get(blockId)!),
    ),
  };
}

/**
 * Where among a block's `items` a box of `slot`'s size lands when dropped with
 * its centre at `centre`: the reading-order index whose place for it, in the
 * block standing at `origin`, lies nearest.
 */
export function slotIndexFor(
  block: LayoutBlock,
  items: readonly GraphBox[],
  slot: GraphBox,
  columns: number,
  origin: Point,
  centre: Point,
): number {
  let best = 0;
  let nearest = Infinity;
  for (let index = 0; index <= items.length; index += 1) {
    const shape = shapeOf(
      block,
      items.toSpliced(index, 0, slot),
      Math.max(1, columns),
    );
    const at = shape.items.find((item) => item.box.id === slot.id)!;
    const distance = Math.hypot(
      origin.x + at.x + slot.width / 2 - centre.x,
      origin.y + at.y + Math.min(slot.height / 2, CENTRE_DEPTH) - centre.y,
    );
    if (distance < nearest) {
      nearest = distance;
      best = index;
    }
  }
  return best;
}

/** How far down a box its centre is taken for dropping, so a tall open card is judged by its head. */
export const CENTRE_DEPTH = 60;

/**
 * `geometry` with one block drawn around `items` in that order from its own
 * top-left, its wire following its top's centre, everything else where it was:
 * the block making room while one of its cards is dragged.
 */
export function withBlockItems(
  geometry: GraphGeometry,
  block: LayoutBlock,
  items: readonly GraphBox[],
  columns: number,
): GraphGeometry {
  const box = geometry.boxes.get(block.id);
  if (box === undefined) {
    return geometry;
  }
  const shape = shapeOf(block, items, Math.max(1, columns));
  const boxes = new Map(geometry.boxes);
  const reshaped = { ...box, width: shape.width, height: shape.height };
  boxes.set(block.id, reshaped);
  for (const item of shape.items) {
    boxes.set(item.box.id, {
      ...item.box,
      x: box.x + item.x,
      y: box.y + item.y,
    });
  }
  const route = geometry.routes.get(block.id);
  const routes = new Map(geometry.routes);
  if (route !== undefined) {
    routes.set(block.id, retargeted(route, box, reshaped));
  }
  return { ...geometry, boxes, routes };
}

function retargeted(
  route: readonly Point[],
  from: PlacedBox,
  to: PlacedBox,
): Point[] {
  const was = from.x + from.width / 2;
  const now = to.x + to.width / 2;
  const points = [...route];
  for (let index = points.length - 1; index > 0; index -= 1) {
    if (points[index]!.x !== was) {
      break;
    }
    points[index] = { ...points[index]!, x: now };
  }
  return withoutRepeats(points);
}

/**
 * The same tree as one column, for a narrow screen: the root on top, every
 * item below it in order, indented, and a wire running down the root's left
 * edge and turning into each box. A box in `unwired` (a project's name over
 * its threads, its "+N more") stands in the column with no wire. Each of
 * `frames` is drawn as a box around its members, from the top of its first,
 * with a gap before it so no two frames touch.
 */
export function layoutColumn(
  root: GraphBox,
  items: readonly GraphBox[],
  unwired: ReadonlySet<string> = new Set(),
  frames: readonly ColumnFrame[] = [],
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
  const opening = new Set(
    frames.flatMap((frame, index) =>
      index === 0 || frame.members[0] === undefined ? [] : [frame.members[0]],
    ),
  );
  for (const item of items) {
    if (opening.has(item.id)) {
      y += FRAME_GAP;
    }
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
  let bottom = y - STACK_GAP;
  for (const frame of frames) {
    const members = frame.members.flatMap((id) => {
      const box = boxes.get(id);
      return box === undefined ? [] : [box];
    });
    if (members.length === 0) {
      continue;
    }
    const left = Math.min(...members.map((box) => box.x)) - FRAME_PAD;
    const right =
      Math.max(...members.map((box) => box.x + box.width)) + FRAME_PAD;
    const lowest =
      Math.max(...members.map((box) => box.y + box.height)) + FRAME_PAD;
    boxes.set(frame.id, {
      id: frame.id,
      x: left,
      y: members[0]!.y,
      width: right - left,
      height: lowest - members[0]!.y,
    });
    width = Math.max(width, right + MARGIN);
    bottom = Math.max(bottom, lowest);
  }
  return { width, height: bottom + MARGIN, boxes, routes };
}

/** A box the column draws around a run of its items: one project's heading and threads. */
export interface ColumnFrame {
  id: string;
  members: readonly string[];
}

const FRAME_PAD = 12;
const FRAME_GAP = 16;
