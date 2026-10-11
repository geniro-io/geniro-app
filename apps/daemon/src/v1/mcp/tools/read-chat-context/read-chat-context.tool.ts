import {
  type ChatContextQuery,
  HOST_READ_CHAT_CONTEXT_TOOL,
} from '../../../agents/chat.types';
import type { HistoryArgs } from '../../mcp.types';
import { HistoryMcpTool } from '../history-mcp-tool';
import { readChatContextInstructions } from './read-chat-context.instructions';
import { readChatContextArgs } from './read-chat-context.reader';
import { readChatContextSchema } from './read-chat-context.schema';

/** `read_chat_context` — the messages around one `search_chats` hit. */
export class ReadChatContextTool extends HistoryMcpTool<ChatContextQuery> {
  readonly name = HOST_READ_CHAT_CONTEXT_TOOL;

  protected instructions(): string {
    return readChatContextInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return readChatContextSchema();
  }

  protected read(args: Record<string, unknown>): HistoryArgs<ChatContextQuery> {
    return readChatContextArgs(args);
  }

  protected answer(query: ChatContextQuery): Promise<unknown> {
    return this.history.context(query);
  }
}
