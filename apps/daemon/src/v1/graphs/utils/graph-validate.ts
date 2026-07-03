import { BadRequestException } from '@packages/common';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';

/**
 * Structural graph validation, ported from Geniro's
 * `graph-compiler.ts` `validateSchema` (apps/api graphs). The template
 * connection/config rules do not apply here — every geniro-app node is an
 * agent — so what remains is the shape validation zod cannot express:
 * id uniqueness and edge referential integrity. Cycles are rejected by
 * `computeRunOrder` (graph-order.ts), matching the source's split.
 */
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
}
