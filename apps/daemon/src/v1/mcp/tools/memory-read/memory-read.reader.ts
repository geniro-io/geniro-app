import { z } from 'zod';

import {
  MEMORY_HANDLE_PATTERN,
  MEMORY_READ_MAX,
  MEMORY_RESULT_PREFACE,
  type MemoryEntry,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { memoryEntryText } from '../memory-mcp-tool';
import { readToolArgs } from '../tool-args';

export const MemoryReadArgsSchema = z
  .object({
    ids: z
      .array(
        z.string().trim().regex(MEMORY_HANDLE_PATTERN, 'a handle like m12'),
      )
      .min(1)
      .max(MEMORY_READ_MAX)
      .describe(
        `Handles of the entries to read (\`m12\`), at most ${MEMORY_READ_MAX}.`,
      ),
  })
  .strict();
export type MemoryReadArgs = z.infer<typeof MemoryReadArgsSchema>;

export function readMemoryReadArgs(
  args: Record<string, unknown>,
): ToolArgs<MemoryReadArgs> {
  return readToolArgs(MemoryReadArgsSchema, args);
}

export function memoryReadResultText(
  entries: readonly MemoryEntry[],
  missing: readonly string[],
  fence: string,
): string {
  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(
      MEMORY_RESULT_PREFACE,
      ...entries.map((entry) => memoryEntryText(entry, fence)),
    );
  }
  if (missing.length > 0) {
    parts.push(
      `Not found: ${missing.join(', ')} — forgotten, waiting for the user's review, or another project's.`,
    );
  }
  return parts.join('\n\n');
}
