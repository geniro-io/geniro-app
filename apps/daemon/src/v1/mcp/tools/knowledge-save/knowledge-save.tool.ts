import { HOST_KNOWLEDGE_SAVE_TOOL } from '../../../agents/chat.types';
import type { KnowledgeItemsService } from '../../../agents/services/knowledge-items.service';
import type { KnowledgeCallScope } from '../../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../../knowledge/services/knowledge.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { KnowledgeMcpTool } from '../knowledge-mcp-tool';
import type { ThreadToolGates } from '../thread-tools-offer';
import {
  knowledgeItemInstructions,
  knowledgeSaveInstructions,
} from './knowledge-save.instructions';
import {
  knowledgeItemResultText,
  knowledgeSaveResultText,
  readKnowledgeItemArgs,
  readKnowledgeSaveArgs,
} from './knowledge-save.reader';
import {
  knowledgeItemProperties,
  knowledgeSaveSchema,
} from './knowledge-save.schema';

/**
 * `knowledge_save` — a new document or edits to one, proposed to the user or
 * applied as the user's setting says, or in an analysis a `K-` item the user
 * applied, written from the card. Unlisted while agents may only read.
 */
export class KnowledgeSaveTool extends KnowledgeMcpTool {
  readonly name = HOST_KNOWLEDGE_SAVE_TOOL;

  constructor(
    knowledge: KnowledgeService,
    gates: ThreadToolGates,
    private readonly items: Pick<KnowledgeItemsService, 'carryOut'>,
  ) {
    super(knowledge, gates);
  }

  protected override isOffered(): boolean {
    return this.knowledge.agentsMayWrite;
  }

  protected ownInstructions(): string {
    return knowledgeSaveInstructions();
  }

  protected ownSchema(): Record<string, unknown> {
    return knowledgeSaveSchema();
  }

  private carriesOutItems({ runId, memberId }: McpListContext): boolean {
    return this.gates.analysis.canAnalyse(runId, memberId);
  }

  protected override instructions(context: McpListContext): string {
    return this.carriesOutItems(context)
      ? `${super.instructions(context)}${knowledgeItemInstructions()}`
      : super.instructions(context);
  }

  protected override inputSchema(
    context: McpListContext,
  ): Record<string, unknown> {
    const schema = super.inputSchema(context);
    return this.carriesOutItems(context)
      ? {
          ...schema,
          properties: {
            ...(schema.properties as Record<string, unknown>),
            ...knowledgeItemProperties(),
          },
          required: [],
        }
      : schema;
  }

  protected override async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    if (
      args.item === undefined ||
      args.item === null ||
      !this.carriesOutItems(context)
    ) {
      return super.run(args, context);
    }
    const read = readKnowledgeItemArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const { runId, memberId } = context;
    const turn = await this.gates.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    const { actor } = await this.knowledge.callScope(runId, memberId);
    const answer = await this.items.carryOut(turn, actor, read.query.item);
    return this.masked(
      knowledgeItemResultText(read.query.item, answer),
      answer.kind === 'refused' || answer.kind === 'item-refused',
    );
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
