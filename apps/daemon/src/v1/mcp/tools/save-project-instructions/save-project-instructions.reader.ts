import { z } from 'zod';

import {
  hasControlCharacters,
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import {
  MAX_PROJECT_INSTRUCTION_BLOCKS,
  PROJECT_BLOCK_ID_MAX,
  PROJECT_BLOCK_TITLE_MAX,
  PROJECT_INSTRUCTIONS_MAX,
} from '../../../projects/projects.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}$/u;

function isVariationSelector(codePoint: number): boolean {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

/**
 * Whether agent-written text carries a character nobody sees: a format or
 * default-ignorable one, bar a variation selector that styles the pictograph
 * right before it.
 */
function hidesText(value: string): boolean {
  for (const match of value.matchAll(INVISIBLE)) {
    const codePoint = match[0].codePointAt(0) ?? 0;
    if (
      !isVariationSelector(codePoint) ||
      !PICTOGRAPH.test(value.slice(0, match.index))
    ) {
      return true;
    }
  }
  return false;
}

/** Text an agent writes: no control characters and nothing a reader cannot see. */
function visibleText(max: number) {
  return z
    .string()
    .max(max)
    .refine(
      (value) => !hasControlCharacters(value),
      'must not contain control characters',
    )
    .refine(
      (value) => !hidesText(value),
      'must not contain invisible characters (zero-width, bidi or format characters)',
    );
}

function blocksField(source: string) {
  return z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(PROJECT_BLOCK_ID_MAX)
          .describe(
            `The block’s id from ${source}; a new block takes a new id of your own`,
          ),
        title: visibleText(PROJECT_BLOCK_TITLE_MAX).describe(
          'The block’s title, as the editor shows it',
        ),
        text: visibleText(PROJECT_INSTRUCTIONS_MAX).describe(
          'The block’s instruction text',
        ),
      }),
    )
    .max(MAX_PROJECT_INSTRUCTION_BLOCKS)
    .describe(
      `Every instruction block as it should read after the change, in order — each block ${source} lists, with your edits made; keep an id to change that block, leave a block out to remove it, add one with a new id; an empty list clears them`,
    );
}

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
