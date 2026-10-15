import {
  type GlobalChatSearchQuery,
  GlobalChatSearchQuerySchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `search_chats` call's query, or why it cannot be read. */
export function readSearchChatsArgs(
  args: Record<string, unknown>,
): ToolArgs<GlobalChatSearchQuery> {
  return readToolArgs(GlobalChatSearchQuerySchema.strict(), args);
}
