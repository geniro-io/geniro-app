import { toolInputSchema } from '../tool-args';
import {
  BuilderWorkflowChangeArgsSchema,
  SaveWorkflowChangeArgsSchema,
} from './save-workflow-change.reader';

/**
 * `save_workflow_change`'s arguments — generated from the schema they are
 * parsed with. A builder chat sends no recommendation ids.
 */
export function saveWorkflowChangeSchema(
  forBuilder: boolean,
): Record<string, unknown> {
  return toolInputSchema(
    forBuilder ? BuilderWorkflowChangeArgsSchema : SaveWorkflowChangeArgsSchema,
  );
}
