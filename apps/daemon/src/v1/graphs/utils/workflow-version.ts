import { createHash } from 'node:crypto';

import { Document } from 'yaml';

import { type Workflow, WorkflowSchema } from '../graphs.types';

/**
 * The part of a workflow that decides how a run executes: every node field
 * (a node's name and description reach callee prompts), the edges without
 * their label (nothing that runs reads it) and the active-turn cap. The
 * workflow's own name, description and canvas layout are left out, so editing
 * them never makes a new version.
 */
export interface CanonicalGraph {
  maxActiveTurns: number | null;
  nodes: Workflow['nodes'];
  edges: Omit<Workflow['edges'][number], 'label'>[];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An edge's identity — its ends and kind; JSON keeps free-form node ids unambiguous. */
export function edgeIdentity(
  edge: Pick<Workflow['edges'][number], 'from' | 'to' | 'kind'>,
): string {
  return JSON.stringify([edge.from, edge.to, edge.kind]);
}

/** Plain JSON with object keys sorted at every depth and undefined keys dropped. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([a], [b]) => byText(a, b))
        .map(([key, field]) => [key, sortKeys(field)]),
    );
  }
  return value;
}

/**
 * Takes a workflow as the library and run snapshots both hold it — already
 * through `WorkflowYamlSchema`'s defaults — so a field the YAML left to its
 * default and the same field written out hash alike.
 */
export function canonicalGraphOf(workflow: Workflow): CanonicalGraph {
  return {
    maxActiveTurns: workflow.maxActiveTurns ?? null,
    nodes: [...workflow.nodes].sort((a, b) => byText(a.id, b.id)),
    edges: workflow.edges
      .map(({ label: _label, ...edge }) => edge)
      .sort((a, b) => byText(edgeIdentity(a), edgeIdentity(b))),
  };
}

export function canonicalGraphJson(graph: CanonicalGraph): string {
  return JSON.stringify(sortKeys(graph));
}

/**
 * A run's graph version: 16 hex of the canonical graph's sha256. A stored
 * version is never recomputed, so a schema default added later changes the
 * version only of runs made after it.
 */
export function workflowVersionOf(workflow: Workflow): string {
  return createHash('sha256')
    .update(canonicalGraphJson(canonicalGraphOf(workflow)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * A stored canonical graph read back as a `Workflow` (under a placeholder
 * name, which the schema requires), or null when it no longer parses.
 */
export function workflowOfCanonical(json: string): Workflow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const { maxActiveTurns, ...graph } = parsed as Record<string, unknown>;
  const result = WorkflowSchema.safeParse({
    ...graph,
    name: 'version',
    ...(typeof maxActiveTurns === 'number' ? { maxActiveTurns } : {}),
  });
  return result.success ? result.data : null;
}

/**
 * A stored canonical graph as YAML in the library file's field order — what a version's
 * diff is taken over — or null when it no longer parses.
 */
export function canonicalGraphYaml(json: string): string | null {
  const workflow = workflowOfCanonical(json);
  if (workflow === null) {
    return null;
  }
  const { maxActiveTurns, nodes, edges } = workflow;
  // The JSON round trip drops undefined fields, as the library writer does.
  return new Document(
    JSON.parse(JSON.stringify({ maxActiveTurns, nodes, edges })),
  ).toString();
}
