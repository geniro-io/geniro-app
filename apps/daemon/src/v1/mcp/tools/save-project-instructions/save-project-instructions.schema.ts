import { toolInputSchema } from '../tool-args';
import {
  OrdinaryChatInstructionsArgsSchema,
  ProjectChatInstructionsArgsSchema,
  SaveProjectInstructionsArgsSchema,
} from './save-project-instructions.reader';

export type ProjectInstructionsAudience = 'analysis' | 'project' | 'chat';

/** `save_project_instructions`' arguments — generated from the schema they are parsed with, an analysis's, a project chat's or an ordinary chat's. */
export function saveProjectInstructionsSchema(
  audience: ProjectInstructionsAudience,
): Record<string, unknown> {
  switch (audience) {
    case 'project':
      return toolInputSchema(ProjectChatInstructionsArgsSchema);
    case 'chat':
      return toolInputSchema(OrdinaryChatInstructionsArgsSchema);
    case 'analysis':
      return toolInputSchema(SaveProjectInstructionsArgsSchema);
  }
}
