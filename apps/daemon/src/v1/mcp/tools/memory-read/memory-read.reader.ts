import { z } from 'zod';

import {
  MEMORY_HANDLE_PATTERN,
  MEMORY_READ_CALL,
  MEMORY_READ_MAX,
  MEMORY_RESULT_PREFACE,
  type MemoryEntry,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { memoryEntryText } from '../memory-mcp-tool';
import { readToolArgs } from '../tool-args';

const MemoryHandleSchema = z
  .string()
  .trim()
  .regex(MEMORY_HANDLE_PATTERN, 'a handle like m12');

export const MemoryReadArgsSchema = z
  .object({
    ids: z
      .array(MemoryHandleSchema)
      .min(1)
      .max(MEMORY_READ_MAX)
      .optional()
      .describe(
        `Handles of the entries to read (\`m12\`), at most ${MEMORY_READ_MAX}.`,
      ),
    id: MemoryHandleSchema.optional().describe(
      'One handle instead of `ids` (`m12`); send one of the two.',
    ),
  })
  .strict();

export interface MemoryReadArgs {
  ids: string[];
}

/**
 * TWIN PARSER: `askedHandles` in `apps/daemon/src/v1/memory/utils/memory-usage-history.ts`
 * and `readEntry` in `apps/ui/src/renderer/chats/memory-tool-row.tsx` read the
 * handles a stored call asked for; a field accepted here is read there too.
 */
export function readMemoryReadArgs(
  args: Record<string, unknown>,
): ToolArgs<MemoryReadArgs> {
  const read = readHandleArgs(args);
  return read.ok
    ? read
    : {
        ok: false,
        error: `call ${MEMORY_READ_CALL} — at most ${MEMORY_READ_MAX} handles.\n${read.error}`,
      };
}

function readHandleArgs(
  args: Record<string, unknown>,
): ToolArgs<MemoryReadArgs> {
  const read = readToolArgs(MemoryReadArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const { ids, id } = read.query;
  if (ids !== undefined && id !== undefined) {
    return {
      ok: false,
      error: 'send ids (a list of handles) or id (one handle), not both',
    };
  }
  if (ids !== undefined) {
    return { ok: true, query: { ids } };
  }
  return id === undefined
    ? {
        ok: false,
        error: 'ids is required — the handles to read, like ["m12"]',
      }
    : { ok: true, query: { ids: [id] } };
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row, and `readHandles` in
 * `apps/daemon/src/v1/memory/utils/memory-usage-history.ts` reads its entry
 * headers for the usage backfill; reword it there too.
 */
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
      `Not found: ${missing.join(', ')} — forgotten, waiting for the user's review, or another project's or team's.`,
    );
  }
  return parts.join('\n\n');
}
