import { ChatContextQuerySchema } from '../../../agents/chat.types';
import { historyInputSchema } from '../history-mcp-tool';

/** `read_chat_context`'s arguments — generated from the schema they are parsed with. */
export function readChatContextSchema(): Record<string, unknown> {
  return historyInputSchema(ChatContextQuerySchema);
}
