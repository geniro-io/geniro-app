import { GlobalChatSearchQuerySchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `search_chats`'s arguments — generated from the schema they are parsed with. */
export function searchChatsSchema(): Record<string, unknown> {
  return toolInputSchema(GlobalChatSearchQuerySchema);
}
