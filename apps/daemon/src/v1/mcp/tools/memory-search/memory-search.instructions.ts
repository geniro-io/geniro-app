import { HOST_SEARCH_CHATS_TOOL } from '../../../agents/chat.types';

/** What a model reads about `memory_search`. */
export function memorySearchInstructions(): string {
  return (
    'Search the memory every agent shares across Claude Code, Codex and Cursor: durable notes about ' +
    "the user, their preferences and corrections, this project's conventions and decisions, and where " +
    'things live. Use it at the start of a task and whenever you are about to ask the user something ' +
    'or guess at a convention — another agent may already have recorded the answer. It returns each ' +
    "entry's handle (`m12`), revision, scope (global or this project) and an excerpt; read the whole " +
    'entry with memory_read. Entries saved by other agents during your conversation appear here too. ' +
    `Do NOT use it to search past conversations — ${HOST_SEARCH_CHATS_TOOL} does that.`
  );
}
