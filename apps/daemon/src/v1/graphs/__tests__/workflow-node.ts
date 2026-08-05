import { expect } from 'vitest';

import type { WorkflowAgentNode, WorkflowNode } from '../graphs.types';

/**
 * Narrow one node of a parsed workflow to its AGENT arm.
 *
 * `WorkflowNode` is a union — an agent node and a trigger node — and only the
 * agent arm carries `model`, `role` and `approval`. A spec reading those off
 * `wf.nodes[0]` is asserting about a field the union does not have; if the
 * parser ever returned a trigger there, the read would be `undefined` and the
 * assertion would fail with no hint about why.
 *
 * The returned reference is the SAME object, so mutating it (the
 * comment-preserving serializer's round-trip specs patch fields in place)
 * still edits the parsed workflow.
 */
export function agentNode(node: WorkflowNode | undefined): WorkflowAgentNode {
  expect(node?.kind).toBe('agent');
  if (node?.kind !== 'agent') {
    throw new Error(`expected an agent node, got kind '${node?.kind}'`);
  }
  return node;
}
