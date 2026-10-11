import { GlobalChatSearchQuerySchema } from '../../../agents/chat.types';
import { historyInputSchema } from '../history-mcp-tool';

/** `search_chats`'s arguments — generated from the schema they are parsed with. */
export function searchChatsSchema(): Record<string, unknown> {
  return historyInputSchema(GlobalChatSearchQuerySchema);
}
