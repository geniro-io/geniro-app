import { ThreadMessageSendSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `message_thread`'s arguments — generated from the schema they are parsed with. */
export function messageThreadSchema(): Record<string, unknown> {
  return toolInputSchema(ThreadMessageSendSchema);
}
