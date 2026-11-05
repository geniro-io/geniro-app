import { z } from 'zod';

import { hasControlCharacters } from '../../agents/chat.types';
import {
  MAX_PROJECT_INSTRUCTION_BLOCKS,
  PROJECT_BLOCK_ID_MAX,
  PROJECT_BLOCK_TITLE_MAX,
  PROJECT_INSTRUCTIONS_MAX,
} from '../../projects/projects.types';

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

/** A project's instruction blocks as an agent sends them, described against `source`, what the agent read them from. */
export function blocksField(source: string) {
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
        title: visibleText(PROJECT_BLOCK_TITLE_MAX)
          .optional()
          .describe(
            'The block’s title, as the editor shows it; leave it out to keep the title it has',
          ),
        text: visibleText(PROJECT_INSTRUCTIONS_MAX)
          .optional()
          .describe(
            'The block’s instruction text; leave it out to keep the text it has (a new block needs one)',
          ),
      }),
    )
    .max(MAX_PROJECT_INSTRUCTION_BLOCKS)
    .describe(
      `Every instruction block as it should read after the change, in order — each block ${source} lists; send an unchanged block as its id alone, a changed one with its new title and text, a new one with a new id; leave a block out to remove it; an empty list clears them. All texts together may hold at most ${PROJECT_INSTRUCTIONS_MAX} characters`,
    );
}
