import {
  type GlobalChatSearchQuery,
  HOST_SEARCH_CHATS_TOOL,
} from '../../../agents/chat.types';
import type { HistoryArgs } from '../../mcp.types';
import { HistoryMcpTool } from '../history-mcp-tool';
import { searchChatsInstructions } from './search-chats.instructions';
import { readSearchChatsArgs } from './search-chats.reader';
import { searchChatsSchema } from './search-chats.schema';

/** `search_chats` — a word search over every saved chat. */
export class SearchChatsTool extends HistoryMcpTool<GlobalChatSearchQuery> {
  readonly name = HOST_SEARCH_CHATS_TOOL;

  protected instructions(): string {
    return searchChatsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return searchChatsSchema();
  }

  protected read(
    args: Record<string, unknown>,
  ): HistoryArgs<GlobalChatSearchQuery> {
    return readSearchChatsArgs(args);
  }

  protected answer(query: GlobalChatSearchQuery): Promise<unknown> {
    return this.history.search(query);
  }
}
