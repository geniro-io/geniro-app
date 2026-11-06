import { BaseException } from '@packages/common';

import { HOST_MESSAGE_THREAD_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadDeliveryService } from '../../../teams/services/thread-delivery.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { messageThreadInstructions } from './message-thread.instructions';
import {
  messageThreadResultText,
  readMessageThreadArgs,
} from './message-thread.reader';
import { messageThreadSchema } from './message-thread.schema';

/**
 * `message_thread` — one short message to another thread. Deliberately not
 * auto-approved anywhere: outside `auto` the sender's ordinary permission card
 * is the user's one look at the text, and the receiver's mode changes nothing.
 * `tools/call` skips `isOffered`, so `run` refuses from the run row as well.
 */
export class MessageThreadTool extends BaseMcpTool {
  readonly name = HOST_MESSAGE_THREAD_TOOL;

  constructor(
    private readonly threads: ThreadDeliveryService,
    private readonly analysis: AnalysisBroker,
    private readonly teamBuilders: TeamBuilderBroker,
    private readonly projectChats: ProjectChatBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return (
      !this.analysis.canAnalyse(runId, memberId) &&
      !this.teamBuilders.canEdit(runId, memberId) &&
      !this.projectChats.canEdit(runId, memberId)
    );
  }

  protected instructions(): string {
    return messageThreadInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return messageThreadSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, conversationId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readMessageThreadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    try {
      const target = await this.threads.senderTarget(runId);
      if (target === null) {
        return this.text('This chat does not reach other threads.', true);
      }
      return this.text(
        messageThreadResultText(
          await this.threads.send({
            from: { runId, memberId, conversationId, caller, target },
            toRunId: read.query.thread,
            text: read.query.message,
            wake: read.query.wake,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof BaseException) {
        return this.text(`${error.errorCode}: ${error.message}`, true);
      }
      return this.text(
        `${this.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}
