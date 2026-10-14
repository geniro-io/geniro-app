import { toolInputSchema } from '../tool-args';
import { SaveWorkflowChangeArgsSchema } from './save-workflow-change.reader';

/** `save_workflow_change`'s arguments — generated from the schema they are parsed with. */
export function saveWorkflowChangeSchema(): Record<string, unknown> {
  return toolInputSchema(SaveWorkflowChangeArgsSchema);
}
