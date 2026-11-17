import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';

import { PILL_HEIGHT } from './stage-graph';

const MIN_SHRUNK_WIDTH = 56;
const MARGIN = 5;

/** Depth-first cycle breaking starts from the stage nothing names, so a loop's edge back is the one drawn backwards. */
const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.spacing.nodeNode': '12',
  'elk.spacing.edgeNode': '10',
  'elk.spacing.edgeEdge': '8',
  'elk.padding': `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
};

const LAYER_GAPS = {
  roomy: { nodes: '30', edges: '12' },
  tight: { nodes: '16', edges: '6' },
} as const;

type LayerGap = keyof typeof LAYER_GAPS;

const elk = new ELK();

export interface StageBox {
  id: string;
  /** What the pill measures with its whole title. */
  width: number;
}

export interface StageLink {
  key: string;
  from: string;
  to: string;
}

export interface PlacedStageBox {
  id: string;
  x: number;
  y: number;
  width: number;
  /** Narrower than its whole title: the title is cut. */
  cut: boolean;
  /** The layer, counted from the left. */
  column: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface StageGraphGeometry {
  width: number;
  height: number;
  boxes: ReadonlyMap<string, PlacedStageBox>;
  routes: ReadonlyMap<string, readonly Point[]>;
}

export function estimateTextWidth(text: string, bold: boolean): number {
  let width = 0;
  for (const char of text) {
    if (/[iljtf.,:;'|!() ]/.test(char)) {
      width += 3.6;
    } else if (/[mwMW]/.test(char)) {
      width += 10;
    } else if (/[A-Z0-9]/.test(char)) {
      width += 7.8;
    } else {
      width += 6.6;
    }
  }
  return width * (bold ? 1.06 : 1);
}

export function fitWidths(natural: number[], budget: number): number[] {
  const total = (widths: number[]): number =>
    widths.reduce((sum, width) => sum + width, 0);
  if (total(natural) <= budget) {
    return natural;
  }
  const floors = natural.map((width) => Math.min(width, MIN_SHRUNK_WIDTH));
  if (total(floors) >= budget) {
    return floors;
  }
  let low = MIN_SHRUNK_WIDTH;
  let high = Math.max(...natural);
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (total(natural.map((width) => Math.min(width, mid))) > budget) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return natural.map((width) => Math.min(width, low));
}

interface SizedBox {
  id: string;
  width: number;
  height: number;
}

function runLayered(
  id: string,
  boxes: readonly SizedBox[],
  links: readonly StageLink[],
  layoutOptions: Record<string, string>,
): Promise<ElkNode> {
  return elk.layout({
    id,
    layoutOptions,
    children: boxes.map((box) => ({ ...box })),
    edges: links.map((link) => ({
      id: link.key,
      sources: [link.from],
      targets: [link.to],
    })),
  });
}

function runElk(
  boxes: readonly StageBox[],
  links: readonly StageLink[],
  gap: LayerGap,
): Promise<ElkNode> {
  return runLayered(
    'stages',
    boxes.map((box) => ({ ...box, height: PILL_HEIGHT })),
    links,
    {
      ...LAYOUT_OPTIONS,
      'elk.layered.spacing.nodeNodeBetweenLayers': LAYER_GAPS[gap].nodes,
      'elk.layered.spacing.edgeNodeBetweenLayers': LAYER_GAPS[gap].edges,
    },
  );
}

function routesOf(graph: ElkNode): Map<string, Point[]> {
  const routes = new Map<string, Point[]>();
  for (const edge of graph.edges ?? []) {
    const section = edge.sections?.[0];
    if (section !== undefined) {
      routes.set(edge.id, [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]);
    }
  }
  return routes;
}

function columnsOf(graph: ElkNode): Map<string, number> {
  const placed = [...(graph.children ?? [])].sort(
    (a, b) => (a.x ?? 0) - (b.x ?? 0),
  );
  const columns = new Map<string, number>();
  let column = -1;
  let reach = -Infinity;
  for (const child of placed) {
    const left = child.x ?? 0;
    if (left >= reach) {
      column += 1;
    }
    reach = Math.max(reach, left + (child.width ?? 0));
    columns.set(child.id, column);
  }
  return columns;
}

export async function layoutStageGraph(
  boxes: readonly StageBox[],
  links: readonly StageLink[],
  room = 0,
): Promise<StageGraphGeometry> {
  let graph = await runElk(boxes, links, 'roomy');
  const columns = columnsOf(graph);
  let widths = new Map(boxes.map((box) => [box.id, box.width]));
  if (room > 0 && (graph.width ?? 0) > room) {
    graph = await runElk(boxes, links, 'tight');
  }
  if (room > 0 && (graph.width ?? 0) > room) {
    const columnWidths: number[] = [];
    for (const box of boxes) {
      const column = columns.get(box.id) ?? 0;
      columnWidths[column] = Math.max(columnWidths[column] ?? 0, box.width);
    }
    const natural = columnWidths.map((width) => width ?? 0);
    const overhead =
      (graph.width ?? 0) - natural.reduce((sum, width) => sum + width, 0);
    const caps = fitWidths(natural, room - overhead);
    widths = new Map(
      boxes.map((box) => [
        box.id,
        Math.min(box.width, caps[columns.get(box.id) ?? 0] ?? box.width),
      ]),
    );
    graph = await runElk(
      boxes.map((box) => ({ id: box.id, width: widths.get(box.id)! })),
      links,
      'tight',
    );
  }

  const natural = new Map(boxes.map((box) => [box.id, box.width]));
  const boxesOut = new Map<string, PlacedStageBox>();
  for (const child of graph.children ?? []) {
    const width = child.width ?? 0;
    boxesOut.set(child.id, {
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width,
      cut: width < (natural.get(child.id) ?? 0),
      column: columns.get(child.id) ?? 0,
    });
  }
  return {
    width: graph.width ?? 0,
    height: graph.height ?? 0,
    boxes: boxesOut,
    routes: routesOf(graph),
  };
}

export interface TreeBox {
  id: string;
  width: number;
  height: number;
  /** The box this one hangs under; none for the root. */
  parent: string | null;
}

export interface PlacedTreeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreeGraphGeometry {
  width: number;
  height: number;
  boxes: ReadonlyMap<string, PlacedTreeBox>;
  /** Keyed by the child's id: the wire from its parent down to it. */
  routes: ReadonlyMap<string, readonly Point[]>;
}

const TREE_MARGIN = 16;

const TREE_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.mergeEdges': 'true',
  'elk.spacing.nodeNode': '24',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.padding': `[top=${TREE_MARGIN},left=${TREE_MARGIN},bottom=${TREE_MARGIN},right=${TREE_MARGIN}]`,
};

function treeLinks(boxes: readonly TreeBox[]): StageLink[] {
  return boxes.flatMap((box) =>
    box.parent === null ? [] : [{ key: box.id, from: box.parent, to: box.id }],
  );
}

function placedBoxes(
  boxes: readonly TreeBox[],
  at: (box: TreeBox) => { x: number; y: number },
): Map<string, PlacedTreeBox> {
  return new Map(
    boxes.map((box) => [
      box.id,
      { id: box.id, width: box.width, height: box.height, ...at(box) },
    ]),
  );
}

/**
 * A tree drawn top-down by ELK: each layer one row, every child under its
 * parent, wires routed at right angles so none crosses a box. Boxes are
 * listed in the order they should stand left to right.
 */
export async function layoutTreeGraph(
  boxes: readonly TreeBox[],
): Promise<TreeGraphGeometry> {
  const graph = await runLayered('tree', boxes, treeLinks(boxes), TREE_OPTIONS);
  const placed = new Map(
    (graph.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );
  return {
    width: graph.width ?? 0,
    height: graph.height ?? 0,
    boxes: placedBoxes(boxes, (box) => placed.get(box.id) ?? { x: 0, y: 0 }),
    routes: routesOf(graph),
  };
}

const COLUMN_GAP = 16;
const COLUMN_INDENT = 24;
const COLUMN_SPINE = 12;

/**
 * The same tree as one column, for a narrow screen: the root on top, every
 * box below it in order, each indented one step per level, and a wire running
 * down the parent's left edge and turning into each child.
 */
export function layoutTreeColumn(boxes: readonly TreeBox[]): TreeGraphGeometry {
  const depth = new Map<string, number>();
  const depthOf = (box: TreeBox): number => {
    const known = depth.get(box.id);
    if (known !== undefined) {
      return known;
    }
    const parent =
      box.parent === null ? undefined : boxes.find((b) => b.id === box.parent);
    const value = parent === undefined ? 0 : depthOf(parent) + 1;
    depth.set(box.id, value);
    return value;
  };
  let y = TREE_MARGIN;
  let width = 0;
  const tops = new Map<string, { x: number; y: number }>();
  for (const box of boxes) {
    const x = TREE_MARGIN + depthOf(box) * COLUMN_INDENT;
    tops.set(box.id, { x, y });
    y += box.height + COLUMN_GAP;
    width = Math.max(width, x + box.width + TREE_MARGIN);
  }
  const placed = placedBoxes(boxes, (box) => tops.get(box.id)!);
  const routes = new Map<string, Point[]>();
  for (const box of boxes) {
    const parent = box.parent === null ? undefined : placed.get(box.parent);
    const child = placed.get(box.id)!;
    if (parent === undefined) {
      continue;
    }
    const spineX = parent.x + COLUMN_SPINE;
    const middle = child.y + Math.min(child.height / 2, 28);
    routes.set(box.id, [
      { x: spineX, y: parent.y + parent.height },
      { x: spineX, y: middle },
      { x: child.x, y: middle },
    ]);
  }
  return {
    width,
    height: y - COLUMN_GAP + TREE_MARGIN,
    boxes: placed,
    routes,
  };
}

export function roundedPath(points: readonly Point[], radius = 6): string {
  const [first, ...rest] = points;
  if (first === undefined) {
    return '';
  }
  let path = `M ${first.x} ${first.y}`;
  rest.forEach((point, index) => {
    const after = rest[index + 1];
    const before = index === 0 ? first : rest[index - 1]!;
    if (after === undefined) {
      path += ` L ${point.x} ${point.y}`;
      return;
    }
    const inLength = Math.hypot(point.x - before.x, point.y - before.y);
    const outLength = Math.hypot(after.x - point.x, after.y - point.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0) {
      path += ` L ${point.x} ${point.y}`;
      return;
    }
    const enter = {
      x: point.x - ((point.x - before.x) / inLength) * r,
      y: point.y - ((point.y - before.y) / inLength) * r,
    };
    const leave = {
      x: point.x + ((after.x - point.x) / outLength) * r,
      y: point.y + ((after.y - point.y) / outLength) * r,
    };
    path += ` L ${enter.x} ${enter.y} Q ${point.x} ${point.y} ${leave.x} ${leave.y}`;
  });
  return path;
}

export function arrowHeadPath(points: readonly Point[], size = 4): string {
  const tip = points.at(-1);
  const from = points.at(-2);
  if (tip === undefined || from === undefined) {
    return '';
  }
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  return `M ${baseX - uy * size} ${baseY + ux * size} L ${tip.x} ${tip.y} L ${baseX + uy * size} ${baseY - ux * size}`;
}
