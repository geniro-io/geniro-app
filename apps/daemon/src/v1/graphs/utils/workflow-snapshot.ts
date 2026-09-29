import { type Workflow, WorkflowSchema } from '../graphs.types';

/** The copy of a workflow a run keeps — see `Run.workflowSnapshot`. */
export function workflowSnapshotOf(workflow: Workflow): string {
  return JSON.stringify(workflow);
}

/**
 * What a run's snapshot column holds, told apart three ways.
 *
 * `absent` and `unreadable` are different facts and the difference is the
 * point: an EMPTY column is a run made before runs kept a copy, which is frozen
 * from the library on its first read; a column that holds something the
 * current schema cannot read is still the graph that run STARTED with, and
 * replacing it with the library's current copy would silently run a different
 * graph under the old run's name — the defect snapshots exist to prevent.
 * `reason` is the parse's own account, for the error that says so.
 */
export type WorkflowSnapshotReading =
  | { state: 'absent' }
  | { state: 'readable'; workflow: Workflow }
  | { state: 'unreadable'; reason: string };

export function parseWorkflowSnapshot(
  raw: string | null,
): WorkflowSnapshotReading {
  if (raw === null) {
    return { state: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: 'unreadable',
      reason: `not JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const result = WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    return {
      state: 'unreadable',
      reason: result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { state: 'readable', workflow: result.data };
}

/**
 * The workflow a run's snapshot holds, or null when it holds none that the
 * current schema can read.
 *
 * The LENIENT reading, for a caller that only labels a run (the stats page's
 * workflow name) and has a fallback either way. Anything that RUNS the graph
 * must use {@link parseWorkflowSnapshot}, which keeps an unreadable copy apart
 * from a missing one.
 */
export function readWorkflowSnapshot(raw: string | null): Workflow | null {
  const reading = parseWorkflowSnapshot(raw);
  return reading.state === 'readable' ? reading.workflow : null;
}
