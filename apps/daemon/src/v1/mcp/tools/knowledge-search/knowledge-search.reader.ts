import { z } from 'zod';

import {
  KNOWLEDGE_QUERY_MAX_CHARS,
  KNOWLEDGE_SEARCH_DEFAULT,
  KNOWLEDGE_SEARCH_MAX,
  type KnowledgeSearchResult,
} from '../../../knowledge/knowledge.types';
import type { ToolArgs } from '../../mcp.types';
import { knowledgeHitLine } from '../knowledge-mcp-tool';
import { readToolArgs } from '../tool-args';

export const KnowledgeSearchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(KNOWLEDGE_QUERY_MAX_CHARS)
      .optional()
      .describe(
        'Words to find in titles, when-to-read lines and text; every word must match, and when none does, any word may. Leave it out to list what this run sees.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(KNOWLEDGE_SEARCH_MAX)
      .default(KNOWLEDGE_SEARCH_DEFAULT)
      .describe('How many documents to return, best first.'),
  })
  .strict();
export type KnowledgeSearchArgs = z.infer<typeof KnowledgeSearchArgsSchema>;

export function readKnowledgeSearchArgs(
  args: Record<string, unknown>,
): ToolArgs<KnowledgeSearchArgs> {
  return readToolArgs(KnowledgeSearchArgsSchema, args);
}

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `knowledgeToolDocsOf` in `apps/ui/src/renderer/chats/knowledge-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function knowledgeSearchResultText(
  { hits, total }: KnowledgeSearchResult,
  query: string | undefined,
): string {
  if (hits.length === 0) {
    return query
      ? `No knowledge document this run sees matches ${JSON.stringify(query)}.`
      : 'This run sees no knowledge documents.';
  }
  const shown =
    total > hits.length
      ? `Showing ${hits.length} of ${total}.`
      : `${total} ${total === 1 ? 'document' : 'documents'}.`;
  return [
    `Knowledge documents this run sees — ${shown} Unmarked ones were written or approved by the user:`,
    ...hits.map(knowledgeHitLine),
  ].join('\n');
}
