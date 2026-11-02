import { z } from 'zod';

import {
  hasControlCharacters,
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import { PROJECT_INSTRUCTIONS_MAX } from '../../../projects/projects.types';
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

/** An analysis's write of a project's instructions, and the applied items it carries out. */
export const SaveProjectInstructionsArgsSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(200)
    .describe('The projectId view="project" named'),
  instructions: z
    .string()
    .max(PROJECT_INSTRUCTIONS_MAX)
    .refine(
      (value) => !hasControlCharacters(value),
      'must not contain control characters',
    )
    .refine(
      (value) => !hidesText(value),
      'must not contain invisible characters (zero-width, bidi or format characters)',
    )
    .describe(
      'The project’s instructions as they should read in full after the change — the text view="project" returned with your edits made, never only the added part; an empty string clears them',
    ),
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
