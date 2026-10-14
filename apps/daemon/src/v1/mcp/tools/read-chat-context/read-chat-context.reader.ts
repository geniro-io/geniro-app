import {
  type ChatContextQuery,
  ChatContextQuerySchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `read_chat_context` call's query, or why it cannot be read. */
export function readChatContextArgs(
  args: Record<string, unknown>,
): ToolArgs<ChatContextQuery> {
  return readToolArgs(ChatContextQuerySchema.strict(), args);
}
