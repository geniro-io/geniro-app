import { BadRequestException } from '@packages/common';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';

/**
 * Producer/consumer adjacency of a workflow DAG. `producersOf.get(id)` is the
 * set of nodes whose final text feeds `id`'s prompt (its dependencies);
 * `consumersOf.get(id)` is the set of nodes waiting on `id`. The executor
 * schedules a node when all of its producers have completed.
 */
export interface WorkflowEdgeMaps {
  producersOf: Map<string, Set<string>>;
  consumersOf: Map<string, Set<string>>;
}

export function buildEdgeMaps(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): WorkflowEdgeMaps {
  const producersOf = new Map<string, Set<string>>();
  const consumersOf = new Map<string, Set<string>>();
  for (const node of nodes) {
    producersOf.set(node.id, new Set());
    consumersOf.set(node.id, new Set());
  }
  for (const edge of edges) {
    // Producer/consumer adjacency IS data flow — call edges grant a runtime
    // tool, order nothing, and may legally form call cycles, so they never
    // enter the maps (and thus never reach the Kahn sort below).
    if (edge.kind !== 'data') {
      continue;
    }
    producersOf.get(edge.to)?.add(edge.from);
    consumersOf.get(edge.from)?.add(edge.to);
  }
  return { producersOf, consumersOf };
}

/**
 * Nodes that run ONLY when called: agent nodes targeted by ≥1 call edge with
 * no incoming data edge. The executor excludes them from the DAG walk — they
 * are not roots, never enter `schedule()`'s loop or the settled denominator —
 * and launches a fresh turn per CallBroker call instead.
 * `validateRunnableGraph` forbids them from feeding data consumers (a
 * per-call output has no defined place in the DAG order).
 *
 * Structurally typed (`{ id, kind }` / `{ from, to, kind }`) so the ONE
 * predicate serves both the executor (WorkflowNode/WorkflowEdge) and the
 * validator (loosely-typed) — the "call-only node" definition must never
 * diverge between the two, or an invariant fix would silently miss a copy.
 */
export function onDemandNodeIds(
  nodes: readonly { id: string; kind: string }[],
  edges: readonly { from: string; to: string; kind: string }[],
): Set<string> {
  const callTargets = new Set<string>();
  const dataTargets = new Set<string>();
  for (const edge of edges) {
    (edge.kind === 'call' ? callTargets : dataTargets).add(edge.to);
  }
  const onDemand = new Set<string>();
  for (const node of nodes) {
    if (
      node.kind === 'agent' &&
      callTargets.has(node.id) &&
      !dataTargets.has(node.id)
    ) {
      onDemand.add(node.id);
    }
  }
  return onDemand;
}

/**
 * Kahn topological sort, ported from Geniro's `graph-compiler.ts`
 * `getBuildOrder` (:582-645). The source counts OUTGOING edges because its
 * edge semantics are inverted (`edge.from` depends on `edge.to`); geniro-app
 * edges run producer → consumer (`to` depends on `from`), so this port counts
 * INCOMING edges — same algorithm (zero-degree queue, decrement dependents,
 * leftover nodes = cycle), native edge direction.
 */
export function computeRunOrder(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): WorkflowNode[] {
  const { producersOf, consumersOf } = buildEdgeMaps(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const pendingProducers = new Map<string, number>();
  for (const node of nodes) {
    pendingProducers.set(node.id, producersOf.get(node.id)?.size ?? 0);
  }

  const queue: WorkflowNode[] = nodes.filter(
    (n) => pendingProducers.get(n.id) === 0,
  );
  const runOrder: WorkflowNode[] = [];
  let queueHead = 0;

  while (queueHead < queue.length) {
    const current = queue[queueHead++]!;
    runOrder.push(current);

    for (const consumerId of consumersOf.get(current.id) ?? []) {
      const remaining = (pendingProducers.get(consumerId) ?? 0) - 1;
      pendingProducers.set(consumerId, remaining);
      if (remaining === 0) {
        const consumer = nodeMap.get(consumerId);
        if (consumer) {
          queue.push(consumer);
        }
      }
    }
  }

  if (runOrder.length !== nodes.length) {
    const processed = new Set(runOrder.map((n) => n.id));
    const cycleNodes = nodes
      .filter((n) => !processed.has(n.id))
      .map((n) => n.id);
    throw new BadRequestException(
      'GRAPH_CIRCULAR_DEPENDENCY',
      `Graph contains circular dependencies involving nodes: ${cycleNodes.join(', ')}`,
    );
  }

  return runOrder;
}
