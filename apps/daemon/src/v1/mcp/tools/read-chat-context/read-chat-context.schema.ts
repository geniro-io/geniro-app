import { ChatContextQuerySchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `read_chat_context`'s arguments — generated from the schema they are parsed with. */
export function readChatContextSchema(): Record<string, unknown> {
  return toolInputSchema(ChatContextQuerySchema);
}
