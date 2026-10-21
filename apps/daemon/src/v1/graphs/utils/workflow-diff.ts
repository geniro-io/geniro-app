import type { Workflow } from '../graphs.types';

/** How much of one changed value a diff quotes. */
const MAX_QUOTED_CHARS = 400;

/** One node whose definition differs, and which of its fields did. */
export interface ChangedNode {
  id: string;
  fields: { field: string; before: string; after: string }[];
}

/**
 * What changed between two workflows, by node id and edge — structural rather
 * than a text diff of the YAML, which reports a reordered list as a rewrite
 * and says nothing about which node a changed line belongs to.
 *
 * TWIN PARSER: `readDiff` / `diffRows` in
 * `apps/ui/src/renderer/chats/workflow-proposal-payload.ts`, which reads the
 * quoted `before`/`after` values as display text only.
 */
export interface WorkflowDiff {
  identical: boolean;
  workflowFields: string[];
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: ChangedNode[];
  addedEdges: string[];
  removedEdges: string[];
}

function quote(value: unknown): string {
  const text = value === undefined ? '(unset)' : JSON.stringify(value);
  return text.length <= MAX_QUOTED_CHARS
    ? text
    : `${text.slice(0, MAX_QUOTED_CHARS)}… [+${text.length - MAX_QUOTED_CHARS} chars]`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function edgeKey(edge: Workflow['edges'][number]): string {
  return `${edge.from} → ${edge.to} (${edge.kind})`;
}

export function diffWorkflows(before: Workflow, after: Workflow): WorkflowDiff {
  const workflowFields = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter(
    (field) =>
      field !== 'nodes' &&
      field !== 'edges' &&
      !same(
        (before as Record<string, unknown>)[field],
        (after as Record<string, unknown>)[field],
      ),
  );
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const changedNodes: ChangedNode[] = [];
  for (const [id, next] of afterNodes) {
    const previous = beforeNodes.get(id);
    if (previous === undefined) {
      continue;
    }
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const fields = [...keys]
      .filter(
        (key) =>
          !same(
            (previous as Record<string, unknown>)[key],
            (next as Record<string, unknown>)[key],
          ),
      )
      .map((field) => ({
        field,
        before: quote((previous as Record<string, unknown>)[field]),
        after: quote((next as Record<string, unknown>)[field]),
      }));
    if (fields.length > 0) {
      changedNodes.push({ id, fields });
    }
  }
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  const diff = {
    workflowFields,
    addedNodes: [...afterNodes.keys()].filter((id) => !beforeNodes.has(id)),
    removedNodes: [...beforeNodes.keys()].filter((id) => !afterNodes.has(id)),
    changedNodes,
    addedEdges: [...afterEdges].filter((edge) => !beforeEdges.has(edge)),
    removedEdges: [...beforeEdges].filter((edge) => !afterEdges.has(edge)),
  };
  return {
    identical:
      diff.workflowFields.length === 0 &&
      diff.addedNodes.length === 0 &&
      diff.removedNodes.length === 0 &&
      diff.changedNodes.length === 0 &&
      diff.addedEdges.length === 0 &&
      diff.removedEdges.length === 0,
    ...diff,
  };
}
