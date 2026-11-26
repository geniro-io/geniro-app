import { Logger } from '@nestjs/common';

import { HOST_PLUGIN_TOOL } from '../../../agents/chat.types';
import type { PluginProposalBroker } from '../../../agents/services/plugin-proposal.broker';
import { hostPluginResultText } from '../../../agents/utils/host-plugin';
import type { PluginProposalService } from '../../../plugins/services/plugin-proposal.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { savePluginInstructions } from './save-plugin.instructions';
import { readSavePluginArgs } from './save-plugin.reader';
import { savePluginSchema } from './save-plugin.schema';

/**
 * `save_plugin` — a chat's (or a team lead's) new or changed Geniro Plugin.
 * It parks on a card showing the command, folders and buttons in every
 * approval mode, and only that card's Approve writes the file.
 */
export class SavePluginTool extends BaseMcpTool {
  readonly name = HOST_PLUGIN_TOOL;
  private readonly logger = new Logger(SavePluginTool.name);

  constructor(
    private readonly cards: PluginProposalBroker,
    private readonly proposals: PluginProposalService,
  ) {
    super();
  }

  protected isOffered({
    runId,
    memberId,
    conversationId,
  }: McpListContext): boolean {
    return this.cards.canPropose(runId, memberId, conversationId);
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return savePluginInstructions(this.cards.answersAtOnce(runId, memberId));
  }

  protected inputSchema(): Record<string, unknown> {
    return savePluginSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    if (!this.isOffered(context)) {
      return this.text(
        'Nothing saved: plugins are made from a chat, or by the lead of a team run in its own conversation, and no such turn is running here.',
        true,
      );
    }
    const read = readSavePluginArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    try {
      const prepared = await this.proposals.prepare(runId, read.query);
      if (!prepared.ok) {
        return this.invalidArgs(prepared.error);
      }
      const outcome = await context.whileCancellable((signal) =>
        this.cards.propose(runId, memberId, prepared.proposal, signal),
      );
      return this.answerTo(
        outcome,
        hostPluginResultText(outcome),
        outcome.status === 'stale' || outcome.status === 'unavailable',
      );
    } catch (error) {
      this.logger.error(
        `run ${runId} could not propose a plugin: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.failedInGeniro(
        `${this.name} failed internally — nothing was saved.`,
      );
    }
  }
}
