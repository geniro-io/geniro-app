import { BaseException } from '@packages/common';

import { type Workflow, WorkflowSchema } from '../graphs.types';
import { computeRunOrder } from './graph-order';
import { validateWorkflowGraph } from './graph-validate';
import { assertValidStages } from './stage-validate';

export type WorkflowCheck =
  | { ok: true; workflow: Workflow }
  /** `code` is the graph rule's own (`GRAPH_…`), or `INVALID_WORKFLOW`. */
  | { ok: false; code: string; message: string };

/**
 * An agent's workflow JSON read as a library file would have to be: the
 * default-free `WorkflowSchema` (never `WorkflowYamlSchema`, whose defaults would
 * quietly give an agent node `approval: 'auto'`), the graph rules, and a run
 * order. The message names at most five schema issues.
 */
export function checkWorkflow(input: unknown): WorkflowCheck {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_WORKFLOW',
      message: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  try {
    validateWorkflowGraph(parsed.data.nodes, parsed.data.edges);
    computeRunOrder(parsed.data.nodes, parsed.data.edges);
    assertValidStages(parsed.data);
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof BaseException ? error.errorCode : 'INVALID_WORKFLOW',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, workflow: parsed.data };
}
