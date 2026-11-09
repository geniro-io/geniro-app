import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { blocksField } from '../project-block-args';
import { readToolArgs } from '../tool-args';

/**
 * An analysis's write of a project's instructions: with `ids`, the applied items
 * it carries out, of a project it read through view="project"; without, a change
 * the user asked for in their own words to any project.
 */
export const SaveProjectInstructionsArgsSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The projectId view="project" named, or the `id` list_projects names',
    ),
  blocks: blocksField('view="project" or list_projects with `project`'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe(
      'The `instructionsRevision` view="project" or list_projects with `project` returned',
    ),
  ids: z
    .array(
      RecommendationIdSchema.regex(
        /^P-/,
        'only P- items change project instructions',
      ),
    )
    .min(1)
    .max(MAX_RECOMMENDATIONS_PER_TARGET)
    .optional()
    .describe(
      'The P-n ids this change carries out; leave it out for a change the user asked for in their own words',
    ),
});
export type SaveProjectInstructionsArgs = z.infer<
  typeof SaveProjectInstructionsArgsSchema
>;

/** A project chat's write: its own project's instructions, unless it names another. */
export const ProjectChatInstructionsArgsSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Another project's `id` list_projects names; leave it out for this chat's own",
    ),
  blocks: blocksField('your brief, or list_projects with `project`'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe(
      'The instructions revision your brief names, or the `instructionsRevision` list_projects with `project` named',
    ),
});
export type ProjectChatInstructionsArgs = z.infer<
  typeof ProjectChatInstructionsArgsSchema
>;

export const OrdinaryChatInstructionsArgsSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(200)
    .describe("The project's `id` list_projects names"),
  blocks: blocksField('list_projects with `project`'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe('The `instructionsRevision` list_projects with `project` named'),
});
export type OrdinaryChatInstructionsArgs = z.infer<
  typeof OrdinaryChatInstructionsArgsSchema
>;

export function readOrdinaryChatInstructionsArgs(
  args: Record<string, unknown>,
): ToolArgs<OrdinaryChatInstructionsArgs> {
  return readToolArgs(OrdinaryChatInstructionsArgsSchema.strict(), args);
}

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
