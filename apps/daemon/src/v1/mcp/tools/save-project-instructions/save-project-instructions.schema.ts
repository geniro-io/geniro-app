import { toolInputSchema } from '../tool-args';
import { SaveProjectInstructionsArgsSchema } from './save-project-instructions.reader';

/** `save_project_instructions`' arguments — generated from the schema they are parsed with. */
export function saveProjectInstructionsSchema(): Record<string, unknown> {
  return toolInputSchema(SaveProjectInstructionsArgsSchema);
}
