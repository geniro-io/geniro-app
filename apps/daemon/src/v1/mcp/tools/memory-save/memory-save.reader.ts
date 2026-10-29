import { z } from 'zod';

import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_HANDLE_PATTERN,
  MEMORY_RESULT_PREFACE,
  MEMORY_TITLE_MAX_CHARS,
  MEMORY_TYPES,
  type MemorySaveInput,
  type MemorySaveOutcome,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { memoryEntryLine, memoryEntryText } from '../memory-mcp-tool';
import { readToolArgs } from '../tool-args';

const HANDLE = z
  .string()
  .trim()
  .regex(MEMORY_HANDLE_PATTERN, 'a handle like m12');

/** Lengths are checked by `MemoryService`, which words the refusal. */
export const MemorySaveArgsSchema = z
  .object({
    id: HANDLE.optional().describe(
      'The handle of an entry to update in place (`m12`). Omit to create a new entry.',
    ),
    rev: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Required with `id`: the revision you read. A changed entry is refused and returned to you.',
      ),
    title: z
      .string()
      .describe(
        `One line naming the fact, at most ${MEMORY_TITLE_MAX_CHARS} characters — it is what other agents see in their index.`,
      ),
    body: z
      .string()
      .describe(
        `The fact and why it holds, standing alone for a reader without your context; at most ${MEMORY_BODY_MAX_BYTES} bytes.`,
      ),
    type: z
      .enum(MEMORY_TYPES)
      .optional()
      .describe(
        'user — who the user is and how they work; feedback — a correction or preference the user gave; project — a convention, decision or fact about this codebase; reference — where something lives. Default project.',
      ),
    scope: z
      .enum(['project', 'global'])
      .optional()
      .describe(
        "project — only runs in this project see it (the default when the run has one); global — every project's runs see it, for facts about the user or the machine.",
      ),
    notDuplicateOf: z
      .array(HANDLE)
      .max(10)
      .optional()
      .describe(
        'Handles a previous save named as near-duplicates that you checked and that say something else.',
      ),
  })
  .strict();

export function readMemorySaveArgs(
  args: Record<string, unknown>,
): ToolArgs<MemorySaveInput> {
  const read = readToolArgs(MemorySaveArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const { id, ...rest } = read.query;
  if (id !== undefined && rest.rev === undefined) {
    return {
      ok: false,
      error: 'rev is required with id — read the entry first with memory_read',
    };
  }
  return { ok: true, query: id === undefined ? rest : { ...rest, handle: id } };
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function memorySaveResultText(
  outcome: MemorySaveOutcome,
  fence: string,
): {
  text: string;
  isError: boolean;
} {
  switch (outcome.kind) {
    case 'created':
    case 'updated': {
      const verb = outcome.kind === 'created' ? 'Saved' : 'Updated';
      const pending =
        outcome.entry.status === 'pending'
          ? " It waits for the user's review before any agent sees it."
          : '';
      return {
        text: `${verb} ${memoryEntryLine(outcome.entry)}.${pending}`,
        isError: false,
      };
    }
    case 'near_duplicate': {
      const vouch = [
        ...outcome.candidates.map((hit) => hit.handle),
        ...outcome.pending,
      ];
      const how =
        outcome.updatable && outcome.candidates.length > 0
          ? 'Update one of them (memory_save with its id and rev), or, if yours says something else, save again with notDuplicateOf naming them.'
          : `If yours says something else, save again with notDuplicateOf: [${vouch.map((h) => `"${h}"`).join(', ')}]; otherwise do not save it again.`;
      return {
        text: [
          ...(outcome.candidates.length > 0
            ? [
                MEMORY_RESULT_PREFACE,
                ...outcome.candidates.map(
                  (hit) => `- ${memoryEntryLine(hit)}: ${hit.excerpt}`,
                ),
              ]
            : []),
          ...(outcome.pending.length > 0
            ? [
                `Waiting for the user's review, with a title like yours (not shown): ${outcome.pending.join(', ')}.`,
              ]
            : []),
          `Not saved: this looks like a note memory already has. ${how}`,
        ].join('\n'),
        isError: true,
      };
    }
    case 'stale':
      return {
        text: `${MEMORY_RESULT_PREFACE}\n\n${memoryEntryText(outcome.current, fence)}\n\nNot saved: ${outcome.current.handle} changed since you read it. Merge your change into the entry above and save again with rev ${outcome.current.rev}.`,
        isError: true,
      };
    case 'refused':
      return { text: `${outcome.code}: ${outcome.reason}`, isError: true };
  }
}
