import { HOST_KNOWLEDGE_READ_TOOL } from '../../../agents/chat.types';
import type { KnowledgeCallScope } from '../../../knowledge/knowledge.types';
import type { McpToolResult } from '../../mcp.types';
import { knowledgeFence, KnowledgeMcpTool } from '../knowledge-mcp-tool';
import { knowledgeReadInstructions } from './knowledge-read.instructions';
import {
  knowledgeMissingText,
  knowledgeReadResultText,
  readKnowledgeReadArgs,
} from './knowledge-read.reader';
import { knowledgeReadSchema } from './knowledge-read.schema';

/** `knowledge_read` — one document by handle, a page at a time. */
export class KnowledgeReadTool extends KnowledgeMcpTool {
  readonly name = HOST_KNOWLEDGE_READ_TOOL;

  protected ownInstructions(): string {
    return knowledgeReadInstructions();
  }

  protected ownSchema(): Record<string, unknown> {
    return knowledgeReadSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { place, elsewhere }: KnowledgeCallScope,
  ): Promise<McpToolResult> {
    const read = readKnowledgeReadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const found = await this.knowledge.read(place, read.query.handle);
    if (found.kind === 'missing') {
      return this.masked(
        knowledgeMissingText(read.query.handle, found.similar),
        true,
      );
    }
    return this.masked(
      knowledgeReadResultText(
        found.document,
        read.query,
        knowledgeFence(),
        elsewhere === true,
      ),
    );
  }
}
