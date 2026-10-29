import { z } from 'zod';

import {
  MEMORY_RESULT_PREFACE,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  type MemoryHit,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { memoryEntryLine } from '../memory-mcp-tool';
import { readToolArgs } from '../tool-args';

export const MemorySearchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(300)
      .describe(
        'Words to find in titles and bodies. All must match (prefix match); `OR` between words means either.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_SEARCH_MAX)
      .default(MEMORY_SEARCH_DEFAULT)
      .describe('How many entries to return, best first.'),
  })
  .strict();
export type MemorySearchArgs = z.infer<typeof MemorySearchArgsSchema>;

export function readMemorySearchArgs(
  args: Record<string, unknown>,
): ToolArgs<MemorySearchArgs> {
  return readToolArgs(MemorySearchArgsSchema, args);
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function memorySearchResultText(
  query: string,
  hits: readonly MemoryHit[],
): string {
  if (hits.length === 0) {
    return `No memory matches "${query}". Try other words, or save what you learn with memory_save.`;
  }
  return [
    MEMORY_RESULT_PREFACE,
    ...hits.map((hit) => `- ${memoryEntryLine(hit)}: ${hit.excerpt}`),
    'Read whole entries with memory_read.',
  ].join('\n');
}
