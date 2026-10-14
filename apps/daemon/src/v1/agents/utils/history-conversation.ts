import type { HistoryConversation } from '../chat.types';

/**
 * The conversation `GET …/items` was asked to read (`HistoryQueryDto.conversation`
 * / `.call`), or undefined for the whole run. The DTO refuses both at once.
 */
export function historyConversationOf(query: {
  conversation?: 'root';
  call?: string;
}): HistoryConversation | undefined {
  if (query.conversation === 'root') {
    return { root: true };
  }
  return query.call === undefined ? undefined : { call: query.call };
}
