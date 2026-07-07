import { BadRequestException } from '@packages/common';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';
import { NODE_CONNECTION_RULES } from '../graphs.types';
import { onDemandNodeIds } from './graph-order';

/**
 * Structural graph validation, ported from Geniro's
 * `graph-compiler.ts` `validateSchema` (apps/api graphs): id uniqueness,
 * edge referential integrity, and the typed connection rules (the geniro
 * `ConnectionRule` model — which node kinds may feed which). Cycles are
 * rejected by `computeRunOrder` (graph-order.ts), matching the source's
 * split.
 */

/** Structural shape of one connection rule (see `ConnectionRule`). */
interface EdgeRule {
  edge: string;
  kind: string;
  required?: boolean;
  multiple?: boolean;
}

/** The connection contract of one node kind. */
interface KindRules {
  inputs: readonly EdgeRule[];
  outputs: readonly EdgeRule[];
}

/**
 * Enforce the typed connection rules over the edge list. Generic over the
 * kind strings (nodes/rules only need `{ id, kind }` / a rules record) so
 * specs can drive multi-kind registries before a second real kind exists;
 * production callers go through `validateWorkflowGraph`, which passes the
 * real `NODE_CONNECTION_RULES`.
 *
 * Checks per edge `from → to` of a given edge kind:
 * - `from`'s kind must list (edge kind, `to`'s kind) in `outputs`, and `to`'s
 *   kind must list (edge kind, `from`'s kind) in `inputs` (both sides agree);
 * - a rule without `multiple` admits at most ONE matching edge on its side;
 * - at most one edge per (from, to, edge kind) — duplicate wires are invalid;
 * and per node: every `required` input rule must be satisfied by ≥1 edge of
 * its edge kind.
 */
export function validateEdgeRules(
  nodes: readonly { id: string; kind: string }[],
  edges: readonly { from: string; to: string; kind: string }[],
  rules: Record<string, KindRules>,
): void {
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const rulesOf = (kind: string): KindRules => {
    const kindRules = rules[kind];
    if (!kindRules) {
      throw new BadRequestException(
        'GRAPH_UNKNOWN_NODE_KIND',
        `No connection rules registered for node kind '${kind}'`,
      );
    }
    return kindRules;
  };

  // Per (node id, direction, edge kind, counterpart kind) counts for
  // `multiple` — a data wire and a call wire to the same peer are separate
  // ports and must never share a count bucket.
  const outCounts = new Map<string, number>();
  const inCounts = new Map<string, number>();
  const bump = (counts: Map<string, number>, key: string): number => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  const seenPairs = new Set<string>();

  for (const edge of edges) {
    const fromKind = kindOf.get(edge.from);
    const toKind = kindOf.get(edge.to);
    if (fromKind === undefined || toKind === undefined) {
      continue; // referential integrity is validateWorkflowGraph's own check
    }

    // Delimiter-safe identity: node ids are free-form (hand-written YAML may
    // contain '->' or '#'), so a joined string could collide two distinct
    // edges — JSON keeps the three components unambiguous.
    const pair = JSON.stringify([edge.from, edge.to, edge.kind]);
    if (seenPairs.has(pair)) {
      throw new BadRequestException(
        'GRAPH_EDGE_RULE',
        `Duplicate ${edge.kind} edge '${edge.from}' -> '${edge.to}'`,
      );
    }
    seenPairs.add(pair);

    const outRule = rulesOf(fromKind).outputs.find(
      (r) => r.edge === edge.kind && r.kind === toKind,
    );
    const inRule = rulesOf(toKind).inputs.find(
      (r) => r.edge === edge.kind && r.kind === fromKind,
    );
    if (!outRule || !inRule) {
      throw new BadRequestException(
        'GRAPH_EDGE_RULE',
        `Edge '${edge.from}' → '${edge.to}' is not allowed: kind '${fromKind}' cannot ${edge.kind === 'call' ? 'call' : 'feed'} kind '${toKind}'`,
      );
    }

    if (
      !outRule.multiple &&
      bump(outCounts, `${edge.from} ${edge.kind} ${toKind}`) > 1
    ) {
      throw new BadRequestException(
        'GRAPH_EDGE_RULE',
        `Node '${edge.from}' allows only one outgoing ${edge.kind} edge to kind '${toKind}'`,
      );
    }
    if (
      !inRule.multiple &&
      bump(inCounts, `${edge.to} ${edge.kind} ${fromKind}`) > 1
    ) {
      throw new BadRequestException(
        'GRAPH_EDGE_RULE',
        `Node '${edge.to}' allows only one incoming ${edge.kind} edge from kind '${fromKind}'`,
      );
    }
  }

  for (const node of nodes) {
    for (const rule of rulesOf(node.kind).inputs) {
      if (!rule.required) {
        continue;
      }
      const satisfied = edges.some(
        (e) =>
          e.to === node.id &&
          e.kind === rule.edge &&
          kindOf.get(e.from) === rule.kind,
      );
      if (!satisfied) {
        throw new BadRequestException(
          'GRAPH_REQUIRED_INPUT',
          `Node '${node.id}' requires an incoming ${rule.edge} edge from kind '${rule.kind}'`,
        );
      }
    }
  }
}

export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): void {
  const ids = nodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new BadRequestException(
      'GRAPH_DUPLICATE_NODE',
      `Duplicate node id(s): ${[...new Set(dupes)].join(', ')}`,
    );
  }

  for (const edge of edges) {
    if (!uniqueIds.has(edge.from)) {
      throw new BadRequestException(
        'GRAPH_EDGE_NOT_FOUND',
        `Edge references non-existent source node: ${edge.from}`,
      );
    }
    if (!uniqueIds.has(edge.to)) {
      throw new BadRequestException(
        'GRAPH_EDGE_NOT_FOUND',
        `Edge references non-existent target node: ${edge.to}`,
      );
    }
    if (edge.from === edge.to) {
      throw new BadRequestException(
        'GRAPH_CIRCULAR_DEPENDENCY',
        `Edge from '${edge.from}' to itself is a cycle`,
      );
    }
  }

  validateEdgeRules(nodes, edges, NODE_CONNECTION_RULES);
}

/**
 * Run-start-only checks, on top of `validateWorkflowGraph`: a workflow is a
 * legal library DRAFT without them (empty canvas, agents not yet wired), but
 * a RUN must enter through a trigger — geniro semantics: firing a trigger is
 * what starts a graph, you never invoke an agent directly. In a cycle-free
 * graph "every root is a trigger" ⟺ "every node is reachable from a
 * trigger", so one root scan covers both.
 */
export function validateRunnableGraph(
  nodes: readonly { id: string; kind: string; name?: string }[],
  edges: readonly { from: string; to: string; kind: string }[],
): void {
  if (nodes.length === 0) {
    throw new BadRequestException(
      'GRAPH_EMPTY',
      'Workflow has no nodes — add at least one agent in the builder',
    );
  }
  if (!nodes.some((n) => n.kind === 'trigger')) {
    throw new BadRequestException(
      'GRAPH_NO_TRIGGER',
      'Workflow has no trigger — add a Manual trigger and connect it to your first agent(s)',
    );
  }
  // Any incoming edge legalizes a node: a data edge puts it on a trigger
  // path; a call edge makes it an on-demand callee (invoked at runtime, not
  // scheduled), so a call-only node is a valid team member.
  const hasIncoming = new Set(edges.map((e) => e.to));
  const untriggered = nodes.find(
    (n) => n.kind !== 'trigger' && !hasIncoming.has(n.id),
  );
  if (untriggered) {
    throw new BadRequestException(
      'GRAPH_UNTRIGGERED_NODE',
      `Node '${untriggered.name ?? untriggered.id}' has no incoming edge — connect it downstream of a trigger or wire a call edge into it`,
    );
  }
  // A call-only node (call target, no data input) runs once per call, on
  // demand — its "final text" has no defined place in the DAG order, so it
  // may not feed data consumers. Give it a data input (it then also runs as
  // a normal DAG node) or drop the outgoing data edge. `onDemandNodeIds` is
  // the SAME predicate the executor uses to exclude these nodes from the DAG
  // walk — sharing it keeps validation and execution from ever disagreeing.
  const onDemand = onDemandNodeIds(nodes, edges);
  for (const node of nodes) {
    if (!onDemand.has(node.id)) {
      continue;
    }
    const feeds = edges.find((e) => e.kind === 'data' && e.from === node.id);
    if (feeds) {
      throw new BadRequestException(
        'GRAPH_CALL_ONLY_PRODUCER',
        `Node '${node.name ?? node.id}' is call-only (runs on demand) — its output cannot feed '${feeds.to}' through a data edge; wire a data input into it or remove that edge`,
      );
    }
  }
}
