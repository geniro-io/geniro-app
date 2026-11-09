import { z } from 'zod';

import { RecommendationIdSchema } from '../../../agents/chat.types';
import type { KnowledgeItemAnswer } from '../../../agents/services/knowledge-items.service';
import {
  KNOWLEDGE_BODY_MAX_BYTES,
  KNOWLEDGE_EDITS_MAX,
  KNOWLEDGE_HANDLE_MAX_CHARS,
  KNOWLEDGE_PLACE_LEVELS,
  KNOWLEDGE_REASON_MAX_CHARS,
  KNOWLEDGE_TITLE_MAX_CHARS,
  KNOWLEDGE_WHEN_MAX_CHARS,
  type KnowledgeSaveOutcome,
} from '../../../knowledge/knowledge.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

const LONGEST_TEXT = KNOWLEDGE_BODY_MAX_BYTES * 4;

export const KnowledgeSaveArgsSchema = z
  .object({
    handle: z
      .string()
      .trim()
      .min(1)
      .max(KNOWLEDGE_HANDLE_MAX_CHARS * 4)
      .optional()
      .describe('The document to change; leave it out to create one.'),
    rev: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The revision you read; required with handle.'),
    title: z
      .string()
      .max(KNOWLEDGE_TITLE_MAX_CHARS * 4)
      .optional()
      .describe('Required to create.'),
    whenToRead: z
      .string()
      .max(KNOWLEDGE_WHEN_MAX_CHARS * 4)
      .optional()
      .describe('One line saying when the document helps. Required to create.'),
    body: z
      .string()
      .max(LONGEST_TEXT)
      .optional()
      .describe('The Markdown text of a new document. Never with handle.'),
    edits: z
      .array(
        z
          .object({
            find: z
              .string()
              .min(1)
              .max(LONGEST_TEXT)
              .describe('Text that appears exactly once.'),
            replace: z.string().max(LONGEST_TEXT).describe('What replaces it.'),
          })
          .strict(),
      )
      .max(KNOWLEDGE_EDITS_MAX)
      .optional()
      .describe(
        'With handle: replacements made in order. One find that is missing or repeated refuses them all.',
      ),
    place: z
      .enum(KNOWLEDGE_PLACE_LEVELS)
      .optional()
      .describe(
        "Where a new document is filed: the run's own project or team, or Global. Never with handle.",
      ),
    reason: z
      .string()
      .min(1)
      .max(KNOWLEDGE_REASON_MAX_CHARS * 4)
      .describe('Why, in one line; the user reads it when reviewing.'),
  })
  .strict();
export type KnowledgeSaveArgs = z.infer<typeof KnowledgeSaveArgsSchema>;

/** An analysis's call carrying out one item the user applied: the text is the card's. */
export const KnowledgeItemArgsSchema = z
  .object({
    item: RecommendationIdSchema.regex(
      /^K-/,
      'only K- items change knowledge',
    ).describe(
      'The K-n id of the applied item to carry out; nothing else goes with it',
    ),
  })
  .strict();

export function readKnowledgeItemArgs(
  args: Record<string, unknown>,
): ToolArgs<z.infer<typeof KnowledgeItemArgsSchema>> {
  return readToolArgs(KnowledgeItemArgsSchema, args);
}

/** What the agent reads back from carrying out a `K-` item. */
export function knowledgeItemResultText(
  id: string,
  answer: KnowledgeItemAnswer,
): string {
  switch (answer.kind) {
    case 'item-refused':
      return `${answer.code}: ${answer.reason}`;
    case 'archived':
      return `Archived \`${answer.document.handle}\` for ${id}, as the user applied it. Mark ${id} now.`;
    case 'applied':
      return `Saved \`${answer.document.handle}\` at rev ${answer.document.rev} for ${id}, as the user applied it. Mark ${id} now.`;
    default:
      return knowledgeSaveResultText(answer);
  }
}

export function readKnowledgeSaveArgs(
  args: Record<string, unknown>,
): ToolArgs<KnowledgeSaveArgs> {
  const read = readToolArgs(KnowledgeSaveArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const { handle, place, edits, rev } = read.query;
  if (handle !== undefined && place !== undefined) {
    return { ok: false, error: 'place only files a new document' };
  }
  if (handle === undefined && (edits !== undefined || rev !== undefined)) {
    return { ok: false, error: 'edits and rev go with handle' };
  }
  return read;
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `saveReadingOf` in `apps/ui/src/renderer/chats/knowledge-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function knowledgeSaveResultText(outcome: KnowledgeSaveOutcome): string {
  switch (outcome.kind) {
    case 'applied':
      return `Saved \`${outcome.document.handle}\` at rev ${outcome.document.rev}. Agents read it now, marked unreviewed.`;
    case 'proposed':
      return `Proposed ${outcome.created ? `a new document \`${outcome.document.handle}\`` : `a change to \`${outcome.document.handle}\``}: it waits for the user's review on the Knowledge page. No agent sees it until they approve, and nothing has changed yet.`;
    case 'stale':
      return `Not saved: \`${outcome.current.handle}\` is at rev ${outcome.current.rev} now. Read it again and redo your edits against that text.`;
    case 'refused':
      return `${outcome.code}: ${outcome.reason}`;
  }
}
