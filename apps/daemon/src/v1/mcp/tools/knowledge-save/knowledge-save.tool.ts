import { HOST_KNOWLEDGE_SAVE_TOOL } from '../../../agents/chat.types';
import type { KnowledgeCallScope } from '../../../knowledge/knowledge.types';
import type { McpToolResult } from '../../mcp.types';
import { KnowledgeMcpTool } from '../knowledge-mcp-tool';
import { knowledgeSaveInstructions } from './knowledge-save.instructions';
import {
  knowledgeSaveResultText,
  readKnowledgeSaveArgs,
} from './knowledge-save.reader';
import { knowledgeSaveSchema } from './knowledge-save.schema';

/**
 * `knowledge_save` — a new document or edits to one, proposed to the user or
 * applied as the user's setting says. Unlisted while agents may only read.
 */
export class KnowledgeSaveTool extends KnowledgeMcpTool {
  readonly name = HOST_KNOWLEDGE_SAVE_TOOL;

  protected override isOffered(): boolean {
    return this.knowledge.agentsMayWrite;
  }

  protected instructions(): string {
    return knowledgeSaveInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return knowledgeSaveSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { place, actor }: KnowledgeCallScope,
  ): Promise<McpToolResult> {
    const read = readKnowledgeSaveArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const outcome = await this.knowledge.save(actor, read.query, place);
    return this.masked(
      knowledgeSaveResultText(outcome),
      outcome.kind === 'refused',
    );
  }
}
