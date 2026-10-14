import { HISTORY_RESULT_PREFACE } from '../../agents/chat.types';
import type { GlobalChatSearchService } from '../../agents/services/global-chat-search.service';
import type { McpToolResult, ToolArgs } from '../mcp.types';
import { BaseMcpTool } from './base-mcp-tool';

/**
 * The base for a tool that reads the saved chat history — `search_chats` and
 * `read_chat_context`, one implementation (`GlobalChatSearchService`) behind
 * both, shared with `GET /v1/chats/search` so the person and an agent get the
 * same answers.
 *
 * Offered to every holder of the endpoint, and deliberately NOT auto-approved
 * by the chat permission gate, unlike the drawing and board tools: they read
 * every project's history, so outside `auto` mode a search is the user's to
 * allow, card by card. For the same reason neither carries MCP's
 * `readOnlyHint`: codex runs a tool annotated read-only without sending an
 * approval request at all (measured on 0.162.0 over app-server under
 * `untrusted`), so the card would never be raised.
 *
 * Every answer is JSON behind {@link HISTORY_RESULT_PREFACE}. The description
 * says the same, but a model reads that once at the start, and a quoted page
 * from another chat can arrive many turns later.
 */
export abstract class HistoryMcpTool<TQuery> extends BaseMcpTool {
  constructor(protected readonly history: GlobalChatSearchService) {
    super();
  }

  protected isOffered(): boolean {
    return true;
  }

  /** The query one call asks, or why it cannot be read — the tool's reader. */
  protected abstract read(args: Record<string, unknown>): ToolArgs<TQuery>;

  /** Answer one query. A throw is answered as a tool error. */
  protected abstract answer(query: TQuery): Promise<unknown>;

  protected async run(args: Record<string, unknown>): Promise<McpToolResult> {
    const read = this.read(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    try {
      return this.text(historyResultText(await this.answer(read.query)));
    } catch (error) {
      return this.text(
        `${this.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}

/** A history answer as the agent reads it: the data line, then the JSON. */
export function historyResultText(result: unknown): string {
  return `${HISTORY_RESULT_PREFACE}\n${JSON.stringify(result)}`;
}
