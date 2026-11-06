import { HOST_LIST_THREADS_TOOL } from '../../../agents/chat.types';
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
import { historyResultText } from '../history-mcp-tool';
import { listThreadsInstructions } from './list-threads.instructions';
import { readListThreadsArgs } from './list-threads.reader';
import { listThreadsSchema } from './list-threads.schema';

/**
 * `list_threads` — which threads an agent can reach. On `BaseMcpTool` rather
 * than `HistoryMcpTool`, whose `run` carries no context: the listing hides the
 * caller's thread and ranks its project. No `readOnlyHint`, on `search_chats`'
 * terms: a read of the user's data outside this chat is the user's to allow.
 */
export class ListThreadsTool extends BaseMcpTool {
  readonly name = HOST_LIST_THREADS_TOOL;

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
    return listThreadsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return listThreadsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readListThreadsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    try {
      if ((await this.threads.senderTarget(runId)) === null) {
        return this.text('This chat does not reach other threads.', true);
      }
      return this.text(
        historyResultText({
          threads: await this.threads.listThreads(runId, read.query),
        }),
      );
    } catch (error) {
      return this.text(
        `${this.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}
