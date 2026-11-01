import { expect } from 'vitest';

import type {
  TeamAgentNode,
  TeamInstructionNode,
  TeamNode,
} from '../teams.types';

/**
 * Narrow one node of a parsed team to its AGENT arm.
 *
 * `TeamNode` is a union — agent, trigger and instruction nodes — and only
 * the agent arm carries `model`, `role` and `approval`. A spec reading those off
 * `wf.nodes[0]` is asserting about a field the union does not have; if the
 * parser ever returned a trigger there, the read would be `undefined` and the
 * assertion would fail with no hint about why.
 *
 * The returned reference is the SAME object, so mutating it (the
 * comment-preserving serializer's round-trip specs patch fields in place)
 * still edits the parsed team.
 */
export function agentNode(node: TeamNode | undefined): TeamAgentNode {
  expect(node?.kind).toBe('agent');
  if (node?.kind !== 'agent') {
    throw new Error(`expected an agent node, got kind '${node?.kind}'`);
  }
  return node;
}

/** {@link agentNode}'s twin for the INSTRUCTION arm, which alone carries `instructions`. */
export function instructionNode(
  node: TeamNode | undefined,
): TeamInstructionNode {
  expect(node?.kind).toBe('instruction');
  if (node?.kind !== 'instruction') {
    throw new Error(`expected an instruction node, got kind '${node?.kind}'`);
  }
  return node;
}
