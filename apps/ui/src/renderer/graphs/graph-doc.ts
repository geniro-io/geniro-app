import type { Edge, Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';

import type {
  Workflow,
  WorkflowLayout,
  WorkflowNode,
} from '../../shared/contracts';

/**
 * Pure Workflow ⇄ React Flow document conversion (no React, unit-testable).
 * The YAML `layout` block is the persisted source of canvas positions; nodes
 * without a stored position get a deterministic staggered-grid fallback so a
 * hand-written file still opens readably.
 */

/** React Flow node carrying its workflow node as data. */
export type AgentFlowNode = Node<{ node: WorkflowNode }, 'agent'>;

const GRID_X = 260;
const GRID_Y = 120;

function fallbackPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * GRID_X, y: Math.floor(index / 3) * GRID_Y };
}

/** Stable edge id for a producer→consumer pair. */
export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

export function toFlow(workflow: Workflow): {
  nodes: AgentFlowNode[];
  edges: Edge[];
} {
  const nodes = workflow.nodes.map((node, index) => ({
    id: node.id,
    type: 'agent' as const,
    position: workflow.layout?.[node.id] ?? fallbackPosition(index),
    data: { node },
  }));
  const edges = workflow.edges.map((edge) => ({
    id: edgeId(edge.from, edge.to),
    source: edge.from,
    target: edge.to,
    label: edge.label,
  }));
  return { nodes, edges };
}

export function fromFlow(
  meta: { name: string; description?: string },
  nodes: readonly AgentFlowNode[],
  edges: readonly Edge[],
): Workflow {
  const layout: WorkflowLayout = {};
  for (const node of nodes) {
    layout[node.id] = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    };
  }
  return {
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    nodes: nodes.map((n) => n.data.node),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
    })),
    layout,
  };
}

/** A fresh node id not colliding with the existing set (`agent-1`, `agent-2`…). */
export function nextNodeId(existing: ReadonlySet<string>): string {
  let n = 1;
  while (existing.has(`agent-${n}`)) {
    n += 1;
  }
  return `agent-${n}`;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 88;

/**
 * Auto-layout via ELK (layered, left→right — matches the producer→consumer
 * edge direction). Returns a fresh layout block; the caller applies it to the
 * canvas and it persists into the YAML on save.
 */
export async function autoLayout(workflow: Workflow): Promise<WorkflowLayout> {
  const elk = new ELK();
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
    },
    children: workflow.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: workflow.edges.map((edge) => ({
      id: edgeId(edge.from, edge.to),
      sources: [edge.from],
      targets: [edge.to],
    })),
  });
  const layout: WorkflowLayout = {};
  for (const child of graph.children ?? []) {
    layout[child.id] = {
      x: Math.round(child.x ?? 0),
      y: Math.round(child.y ?? 0),
    };
  }
  return layout;
}
