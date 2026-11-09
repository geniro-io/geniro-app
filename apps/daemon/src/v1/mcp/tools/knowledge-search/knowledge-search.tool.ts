import { HOST_KNOWLEDGE_SEARCH_TOOL } from '../../../agents/chat.types';
import type { KnowledgeCallScope } from '../../../knowledge/knowledge.types';
import type { McpToolResult } from '../../mcp.types';
import { KnowledgeMcpTool } from '../knowledge-mcp-tool';
import { knowledgeSearchInstructions } from './knowledge-search.instructions';
import {
  knowledgeSearchResultText,
  readKnowledgeSearchArgs,
} from './knowledge-search.reader';
import { knowledgeSearchSchema } from './knowledge-search.schema';

/** `knowledge_search` — the documents a run sees, by query or all of them. */
export class KnowledgeSearchTool extends KnowledgeMcpTool {
  readonly name = HOST_KNOWLEDGE_SEARCH_TOOL;

  protected ownInstructions(): string {
    return knowledgeSearchInstructions();
  }

  protected ownSchema(): Record<string, unknown> {
    return knowledgeSearchSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { place }: KnowledgeCallScope,
  ): Promise<McpToolResult> {
    const read = readKnowledgeSearchArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const found = await this.knowledge.search(
      place,
      read.query.query,
      read.query.limit,
    );
    return this.masked(knowledgeSearchResultText(found, read.query.query));
  }
}
