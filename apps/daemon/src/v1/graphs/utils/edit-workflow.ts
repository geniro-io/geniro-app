import type { Workflow } from '../graphs.types';
import { restoreConfigDirs } from './config-dir-redaction';
import { checkWorkflow } from './workflow-check';
import { applyWorkflowEdits, type WorkflowEdit } from './workflow-edits';

/** Where a builder chat copies a `find` from: the file it read with its own tools. */
export const WORKFLOW_FILE_EDIT_COPY =
  'the workflow file, as the string value itself rather than its YAML quoting or line folding';

export type EditedWorkflow =
  | { ok: true; workflow: Workflow }
  | {
      ok: false;
      error: 'INVALID_EDIT' | 'INVALID_WORKFLOW' | 'CONFIG_DIR_UNKNOWN';
      message: string;
    };

/**
 * `edits` carried out on `current` and the result held to the schema and the
 * graph rules — what `save_workflow_change` and a builder chat's
 * `propose_workflow` both write. With `restoreTokens`, a `configDir` written
 * back as a `read_workflows` token gets its path back from `current`.
 */
export function editWorkflow(
  current: Workflow,
  edits: readonly WorkflowEdit[],
  copyFrom: string,
  restoreTokens: boolean,
): EditedWorkflow {
  const edited = applyWorkflowEdits(current, edits, copyFrom);
  if (!edited.ok) {
    return { ok: false, error: 'INVALID_EDIT', message: edited.message };
  }
  const checked = checkWorkflow(edited.workflow);
  if (!checked.ok) {
    return { ok: false, error: 'INVALID_WORKFLOW', message: checked.message };
  }
  if (!restoreTokens) {
    return checked;
  }
  const restored = restoreConfigDirs(checked.workflow, current);
  return restored.ok
    ? restored
    : { ok: false, error: 'CONFIG_DIR_UNKNOWN', message: restored.message };
}
