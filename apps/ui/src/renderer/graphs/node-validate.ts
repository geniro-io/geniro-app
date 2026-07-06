import type { WorkflowNode } from '../../shared/contracts';
import {
  type ConnectionRule,
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

/** Edges grouped by the peer node's kind (unknown peers are dangling edges
 *  React Flow won't render — skipped rather than flagged). */
function countByPeerKind(
  peerIds: readonly string[],
  kindById: Readonly<Record<string, string>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of peerIds) {
    const kind = kindById[id];
    if (kind !== undefined) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
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
  for (const [peerKind, count] of counts) {
    const rule = rules.find((r) => r.kind === peerKind);
    if (!rule) {
      errors.push({
        type: 'connection',
        side,
        message:
          side === 'input'
            ? `A ${peerKind} node cannot feed this ${nodeKind} node.`
            : `This ${nodeKind} node cannot feed a ${peerKind} node.`,
      });
    } else if (!rule.multiple && count > 1) {
      errors.push({
        type: 'connection',
        side,
        message:
          side === 'input'
            ? `Only one ${peerKind} may feed this node (got ${count}).`
            : `Only one ${peerKind} may follow this node (got ${count}).`,
      });
    }
  }
  return errors;
}

export function validateNode(
  node: WorkflowNode,
  kindById: Readonly<Record<string, string>>,
  edges: readonly { source: string; target: string }[],
): NodeValidationError[] {
  const errors: NodeValidationError[] = [];

  const record = node as unknown as Record<string, unknown>;
  for (const field of NODE_TYPE_SCHEMAS[node.kind]) {
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

  const rules = NODE_CONNECTION_RULES[node.kind];
  const incoming = countByPeerKind(
    edges.filter((e) => e.target === node.id).map((e) => e.source),
    kindById,
  );
  const outgoing = countByPeerKind(
    edges.filter((e) => e.source === node.id).map((e) => e.target),
    kindById,
  );
  errors.push(...sideErrors('input', node.kind, rules.inputs, incoming));
  errors.push(...sideErrors('output', node.kind, rules.outputs, outgoing));

  // Kind-level requirements, mirroring the daemon's run gate: an agent no
  // edge feeds is a non-trigger root (`GRAPH_UNTRIGGERED_NODE`), and a
  // trigger with no outgoing edge fires nothing.
  if (node.kind === 'agent' && incoming.size === 0) {
    errors.push({
      type: 'connection',
      side: 'input',
      message:
        'No input connected — wire a trigger or an upstream agent into this node.',
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
