import {
  type ChatContextQuery,
  ChatContextQuerySchema,
} from '../../../agents/chat.types';
import type { HistoryArgs } from '../../mcp.types';
import { readHistoryArgs } from '../history-mcp-tool';

/** A `read_chat_context` call's query, or why it cannot be read. */
export function readChatContextArgs(
  args: Record<string, unknown>,
): HistoryArgs<ChatContextQuery> {
  return readHistoryArgs(ChatContextQuerySchema.strict(), args);
}
