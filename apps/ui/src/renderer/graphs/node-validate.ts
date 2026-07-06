import type { WorkflowNode } from '../../shared/contracts';
import {
  type ConnectionRule,
  flowEdgeKind,
  NODE_CONNECTION_RULES,
  NODE_TYPE_SCHEMAS,
} from './node-schema';

/**
 * Live builder-side node lint (pure — no React). The per-node mirror of the
 * daemon's gates, so a node that would fail there turns red on the canvas
 * instead of at save/run time:
 *  - `config`   — required schema fields must be filled
 *                 (the daemon's `WorkflowNodeSchema` zod parse)
 *  - `connection` — every edge must be legal for both kinds and within its
 *                 rule's arity (the daemon's `validateEdgeRules` on save);
 *                 an agent nothing feeds can never be reached by a run
 *                 (`GRAPH_UNTRIGGERED_NODE`), and a trigger feeding nothing
 *                 fires no one — both are surfaced per node here.
 */
export interface NodeValidationError {
  type: 'config' | 'connection';
  /** Which ports side the error concerns — tints that side of the card. */
  side?: 'input' | 'output';
  message: string;
}

/** A canvas edge as validation sees it — React Flow's `type` carries the
 *  edge kind (`call` renders through the call component; anything else is
 *  data flow, matching graph-doc's fromFlow). */
export interface CanvasEdge {
  source: string;
  target: string;
  type?: string;
}

/** Edges grouped by (edge kind, peer node kind) — separate buckets, so a call
 *  edge never eats into a data rule's arity (mirrors the daemon's per-kind
 *  count keys). Unknown peers are dangling edges React Flow won't render —
 *  skipped rather than flagged. */
function countByRule(
  edges: readonly { peerId: string; edgeKind: 'data' | 'call' }[],
  kindById: Readonly<Record<string, string>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { peerId, edgeKind } of edges) {
    const kind = kindById[peerId];
    if (kind !== undefined) {
      const key = `${edgeKind} ${kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function sideErrors(
  side: 'input' | 'output',
  nodeKind: string,
  rules: readonly ConnectionRule[],
  counts: ReadonlyMap<string, number>,
): NodeValidationError[] {
  const errors: NodeValidationError[] = [];
  for (const [key, count] of counts) {
    const [edgeKind, peerKind] = key.split(' ') as ['data' | 'call', string];
    const rule = rules.find((r) => r.edge === edgeKind && r.kind === peerKind);
    const verb = edgeKind === 'call' ? 'call' : 'feed';
    if (!rule) {
      errors.push({
        type: 'connection',
        side,
        // "A node of kind '…'" sidesteps the a/an article on the kind name,
        // matching the daemon's quoted-kind message style.
        message:
          side === 'input'
            ? `A node of kind '${peerKind}' cannot ${verb} this ${nodeKind} node.`
            : `This ${nodeKind} node cannot ${verb} a node of kind '${peerKind}'.`,
      });
    } else if (!rule.multiple && count > 1) {
      errors.push({
        type: 'connection',
        side,
        message:
          side === 'input'
            ? `Only one ${peerKind} may ${verb} this node (got ${count}).`
            : `Only one ${peerKind} may follow this node (got ${count}).`,
      });
    }
  }
  return errors;
}

export function validateNode(
  node: WorkflowNode,
  kindById: Readonly<Record<string, string>>,
  edges: readonly CanvasEdge[],
): NodeValidationError[] {
  const errors: NodeValidationError[] = [];

  // A kind outside the registries (a daemon/renderer version skew, or a
  // hand-written file) is reported, never thrown — a node card must degrade
  // to its red state, not blank the app (mirrors GRAPH_UNKNOWN_NODE_KIND).
  const schema = NODE_TYPE_SCHEMAS[node.kind];
  const rules = NODE_CONNECTION_RULES[node.kind];
  if (!schema || !rules) {
    return [
      {
        type: 'config',
        message: `Unknown node kind '${String(node.kind)}' — this app version does not support it.`,
      },
    ];
  }

  const record = node as unknown as Record<string, unknown>;
  for (const field of schema) {
    const value = record[field.key];
    if (
      field.required &&
      (value === undefined || value === null || value === '')
    ) {
      errors.push({
        type: 'config',
        message: `Missing required field '${field.key}'.`,
      });
    }
  }

  const incoming = countByRule(
    edges
      .filter((e) => e.target === node.id)
      .map((e) => ({ peerId: e.source, edgeKind: flowEdgeKind(e) })),
    kindById,
  );
  const outgoing = countByRule(
    edges
      .filter((e) => e.source === node.id)
      .map((e) => ({ peerId: e.target, edgeKind: flowEdgeKind(e) })),
    kindById,
  );
  errors.push(...sideErrors('input', node.kind, rules.inputs, incoming));
  errors.push(...sideErrors('output', node.kind, rules.outputs, outgoing));

  // Kind-level requirements, mirroring the daemon's run gate: an agent no
  // edge feeds is a non-trigger root (`GRAPH_UNTRIGGERED_NODE`) — an incoming
  // CALL edge counts (a call-only callee runs on demand), same as the daemon
  // — and a trigger with no outgoing edge fires nothing.
  if (node.kind === 'agent' && incoming.size === 0) {
    errors.push({
      type: 'connection',
      side: 'input',
      message:
        'No input connected — wire a trigger, an upstream agent, or a call edge into this node.',
    });
  }
  if (node.kind === 'trigger' && outgoing.size === 0) {
    errors.push({
      type: 'connection',
      side: 'output',
      message: 'This trigger fires nothing — connect it to an agent.',
    });
  }
  return errors;
}

/**
 * Node ids taking part in at least one call loop (call edges only). Mutual
 * calls are LEGAL wiring — chained calls are depth-capped at runtime — so
 * this is an advisory lint for the inspector, never a validation error (and
 * the daemon has no warning channel to carry it).
 */
export function callCycleNodeIds(edges: readonly CanvasEdge[]): Set<string> {
  const calleesOf = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (flowEdgeKind(edge) === 'call') {
      const set = calleesOf.get(edge.source) ?? new Set<string>();
      set.add(edge.target);
      calleesOf.set(edge.source, set);
    }
  }
  const cyclic = new Set<string>();
  for (const start of calleesOf.keys()) {
    // Walk the call graph from start's callees; reaching start again closes
    // a loop through it. Canvas graphs are tiny — O(V·E) is fine.
    const queue = [...calleesOf.get(start)!];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (id === start) {
        cyclic.add(start);
        break;
      }
      for (const next of calleesOf.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return cyclic;
}

/** The inspector's "Agent calls" summary for one agent node. */
export interface AgentCallInfo {
  /** Display names this node may invoke (its outgoing call edges). */
  callees: string[];
  /** Display names that may invoke this node (its incoming call edges). */
  callers: string[];
  /** Whether the node takes part in a call loop (see callCycleNodeIds). */
  inCycle: boolean;
}

/**
 * Derive the read-only "Agent calls" section for one node from the live
 * canvas — pure so the section's logic is testable without mounting the
 * builder. Returns null when no call edge touches the node: the section
 * only appears once call wiring exists.
 */
export function agentCallInfo(
  nodeId: string,
  nodes: readonly { id: string; name?: string }[],
  edges: readonly CanvasEdge[],
): AgentCallInfo | null {
  const nameOf = (id: string): string =>
    nodes.find((n) => n.id === id)?.name ?? id;
  const callEdges = edges.filter((e) => flowEdgeKind(e) === 'call');
  const callees = callEdges
    .filter((e) => e.source === nodeId)
    .map((e) => nameOf(e.target));
  const callers = callEdges
    .filter((e) => e.target === nodeId)
    .map((e) => nameOf(e.source));
  if (callees.length === 0 && callers.length === 0) {
    return null;
  }
  return { callees, callers, inCycle: callCycleNodeIds(edges).has(nodeId) };
}
