import { toolInputSchema } from '../tool-args';
import {
  ProjectChatInstructionsArgsSchema,
  SaveProjectInstructionsArgsSchema,
} from './save-project-instructions.reader';

/** `save_project_instructions`' arguments — generated from the schema they are parsed with, an analysis's or a project chat's. */
export function saveProjectInstructionsSchema(
  forProjectChat: boolean,
): Record<string, unknown> {
  return toolInputSchema(
    forProjectChat
      ? ProjectChatInstructionsArgsSchema
      : SaveProjectInstructionsArgsSchema,
  );
}
