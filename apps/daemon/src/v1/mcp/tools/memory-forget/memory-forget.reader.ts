import { z } from 'zod';

import {
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_HANDLE_PATTERN,
  type MemoryForgetOutcome,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

export const MemoryForgetArgsSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(MEMORY_HANDLE_PATTERN, 'a handle like m12')
      .describe('The handle of the entry to forget (`m12`).'),
    reason: z
      .string()
      .describe(
        `Why it no longer holds, in one line of at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters — the user reads it.`,
      ),
  })
  .strict();
export type MemoryForgetArgs = z.infer<typeof MemoryForgetArgsSchema>;

export function readMemoryForgetArgs(
  args: Record<string, unknown>,
): ToolArgs<MemoryForgetArgs> {
  return readToolArgs(MemoryForgetArgsSchema, args);
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function memoryForgetResultText(outcome: MemoryForgetOutcome): {
  text: string;
  isError: boolean;
} {
  return outcome.kind === 'forgotten'
    ? {
        text: `Forgot ${outcome.entry.handle}. No agent sees it any more; it is kept, so the user can bring it back.`,
        isError: false,
      }
    : { text: `${outcome.code}: ${outcome.reason}`, isError: true };
}
