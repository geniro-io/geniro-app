import { type Workflow, WorkflowSchema } from '../graphs.types';

/** The copy of a workflow a run keeps — see `Run.workflowSnapshot`. */
export function workflowSnapshotOf(workflow: Workflow): string {
  return JSON.stringify(workflow);
}

/**
 * The workflow a run's snapshot holds, or null when it holds none that the
 * current schema can read.
 *
 * Read through the schema rather than cast: the column outlives the code that
 * wrote it, and a shape this build cannot run must come back as "no snapshot"
 * rather than as a graph with fields missing.
 */
export function readWorkflowSnapshot(raw: string | null): Workflow | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = WorkflowSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
