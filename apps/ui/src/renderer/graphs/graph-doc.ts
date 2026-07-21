import type { Edge, Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';

import type {
  EdgeKind,
  NodeKind,
  Workflow,
  WorkflowAgentNode,
  WorkflowLayout,
  WorkflowNode,
  WorkflowTriggerNode,
} from '../../shared/contracts';
import { flowEdgeKind, flowEdgeType, makeHandleId } from './node-schema';

/**
 * Pure Workflow ⇄ React Flow document conversion (no React, unit-testable).
 * The YAML `layout` block is the persisted source of canvas positions; nodes
 * without a stored position get a deterministic staggered-grid fallback so a
 * hand-written file still opens readably.
 */

/** React Flow nodes carrying their workflow node as data, typed per kind —
 *  the RF `type` string doubles as the node kind and selects the component. */
export type AgentFlowNode = Node<{ node: WorkflowAgentNode }, 'agent'>;
export type TriggerFlowNode = Node<{ node: WorkflowTriggerNode }, 'trigger'>;
export type GraphFlowNode = AgentFlowNode | TriggerFlowNode;

const GRID_X = 260;
const GRID_Y = 120;

function fallbackPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * GRID_X, y: Math.floor(index / 3) * GRID_Y };
}

/**
 * Stable edge id per (from, to, edge kind) — the kind is part of the identity
 * because a data edge and a call edge may legally share the same endpoints.
 * JSON keeps the components unambiguous: node ids are free-form (hand-written
 * YAML may contain '->' or '#'), and React Flow needs distinct edges to never
 * share an id.
 */
export function edgeId(from: string, to: string, kind: EdgeKind): string {
  return JSON.stringify([from, to, kind]);
}

export function toFlow(workflow: Workflow): {
  nodes: GraphFlowNode[];
  edges: Edge[];
} {
  const nodes = workflow.nodes.map((node, index): GraphFlowNode => {
    const position = workflow.layout?.[node.id] ?? fallbackPosition(index);
    return node.kind === 'trigger'
      ? { id: node.id, type: 'trigger', position, data: { node } }
      : { id: node.id, type: 'agent', position, data: { node } };
  });
  // Edges attach to the per-rule handles. The YAML never stores ports: with
  // at most one rule per (side, edge kind, peer kind) the canonical handle
  // pair is fully derived from the edge kind + endpoint kinds (makeHandleId).
  const kindOf = new Map(workflow.nodes.map((node) => [node.id, node.kind]));
  const edges = workflow.edges.map((edge) => {
    const sourceKind = kindOf.get(edge.from);
    const targetKind = kindOf.get(edge.to);
    return {
      id: edgeId(edge.from, edge.to, edge.kind),
      source: edge.from,
      target: edge.to,
      label: edge.label,
      ...flowEdgeType(edge.kind),
      ...(targetKind
        ? { sourceHandle: makeHandleId('source', edge.kind, targetKind) }
        : {}),
      ...(sourceKind
        ? { targetHandle: makeHandleId('target', edge.kind, sourceKind) }
        : {}),
    };
  });
  return { nodes, edges };
}

export function fromFlow(
  meta: { name: string; description?: string },
  nodes: readonly GraphFlowNode[],
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
    nodes: nodes.map((n): WorkflowNode => n.data.node),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      kind: flowEdgeKind(e),
      ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
    })),
    layout,
  };
}

/**
 * The canvas serialized exactly as Save would write it — the builder's
 * dirty-check baseline (compare the snapshot taken at load/save against the
 * live canvas). Serialize-and-compare beats per-change tracking: selection
 * and other no-op canvas events cannot false-flag, and an edit undone by
 * hand reads clean again.
 */
export function canvasSnapshot(
  name: string,
  description: string,
  nodes: readonly GraphFlowNode[],
  edges: readonly Edge[],
): string {
  const trimmed = description.trim();
  return JSON.stringify(
    fromFlow(
      {
        name: name.trim() || 'workflow',
        ...(trimmed ? { description: trimmed } : {}),
      },
      nodes,
      edges,
    ),
  );
}

/** A fresh node id not colliding with the existing set — prefixed by kind
 *  (`agent-1`, `trigger-1`, …). */
export function nextNodeId(
  existing: ReadonlySet<string>,
  prefix: NodeKind = 'agent',
): string {
  let n = 1;
  while (existing.has(`${prefix}-${n}`)) {
    n += 1;
  }
  return `${prefix}-${n}`;
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 128;

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
      id: edgeId(edge.from, edge.to, edge.kind),
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
