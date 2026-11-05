import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { blocksField } from '../project-block-args';
import { readToolArgs } from '../tool-args';

/** An analysis's write of a project's instructions, and the applied items it carries out. */
export const SaveProjectInstructionsArgsSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(200)
    .describe('The projectId view="project" named'),
  blocks: blocksField('view="project"'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe('The `instructionsRevision` view="project" returned'),
  ids: z
    .array(
      RecommendationIdSchema.regex(
        /^P-/,
        'only P- items change project instructions',
      ),
    )
    .min(1)
    .max(MAX_RECOMMENDATIONS_PER_TARGET)
    .describe('The P-n ids this change carries out'),
});
export type SaveProjectInstructionsArgs = z.infer<
  typeof SaveProjectInstructionsArgsSchema
>;

/** A project chat's write of its own project's instructions: the project is the chat's. */
export const ProjectChatInstructionsArgsSchema = z.object({
  blocks: blocksField('your brief'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe('The instructions revision your brief names'),
});
export type ProjectChatInstructionsArgs = z.infer<
  typeof ProjectChatInstructionsArgsSchema
>;

/** A project chat's `save_project_instructions` arguments, or why they cannot be read. */
export function readProjectChatInstructionsArgs(
  args: Record<string, unknown>,
): ToolArgs<ProjectChatInstructionsArgs> {
  return readToolArgs(ProjectChatInstructionsArgsSchema.strict(), args);
}

/** `save_project_instructions` arguments, or why they cannot be read. */
export function readSaveProjectInstructionsArgs(
  args: Record<string, unknown>,
): ToolArgs<SaveProjectInstructionsArgs> {
  return readToolArgs(SaveProjectInstructionsArgsSchema.strict(), args);
}

/** The answer as the agent reads it, and whether it is a refusal. */
export function projectInstructionsResultText(
  answer: Record<string, unknown>,
): {
  text: string;
  isError: boolean;
} {
  return { text: JSON.stringify(answer), isError: 'error' in answer };
}
