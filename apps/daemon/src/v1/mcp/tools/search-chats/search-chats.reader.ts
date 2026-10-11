import {
  type GlobalChatSearchQuery,
  GlobalChatSearchQuerySchema,
} from '../../../agents/chat.types';
import type { HistoryArgs } from '../../mcp.types';
import { readHistoryArgs } from '../history-mcp-tool';

/** A `search_chats` call's query, or why it cannot be read. */
export function readSearchChatsArgs(
  args: Record<string, unknown>,
): HistoryArgs<GlobalChatSearchQuery> {
  return readHistoryArgs(GlobalChatSearchQuerySchema.strict(), args);
}
