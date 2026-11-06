import {
  HOST_KNOWLEDGE_READ_TOOL,
  HOST_MEMORY_SEARCH_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `knowledge_search`. */
export function knowledgeSearchInstructions(): string {
  return (
    'Find the knowledge documents the user keeps for this run: long guides, recipes and checklists filed in ' +
    'its project, its team or Global. With no query it lists what this run sees, nearest place first. ' +
    'Use it when a task may have a written way of doing it and the index in your instructions does not ' +
    `settle it. Each hit names its handle, revision, place and when to read it, never its text: read one with ${HOST_KNOWLEDGE_READ_TOOL}. ` +
    `Do NOT use it for notes agents left each other — ${HOST_MEMORY_SEARCH_TOOL} does that.`
  );
}
