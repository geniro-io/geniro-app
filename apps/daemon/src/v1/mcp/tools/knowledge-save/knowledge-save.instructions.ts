import {
  HOST_KNOWLEDGE_READ_TOOL,
  HOST_MEMORY_SAVE_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `knowledge_save`. */
export function knowledgeSaveInstructions(): string {
  return (
    'Propose a new knowledge document, or a change to one, for the user to keep: a guide, recipe or checklist ' +
    'worth more than a note. With no handle it creates one and takes title, whenToRead (one line saying when ' +
    "the document helps, not what it holds) and body; it is filed in this run's project, else its team, else Global, " +
    `unless you pass place. With a handle it changes that document at the rev you read with ${HOST_KNOWLEDGE_READ_TOOL}: pass edits, ` +
    'each find unique in the text, and optionally a new title or whenToRead, never a whole body. Always say why in reason. ' +
    'While the user reviews agent writes, what you save waits for them on the Knowledge page: no agent sees it, and the document stays as it was. ' +
    `Do NOT use it for one durable fact — ${HOST_MEMORY_SAVE_TOOL} does that — nor for secrets, or your progress.`
  );
}

/** What an analysis also reads about `knowledge_save`. */
export function knowledgeItemInstructions(): string {
  return (
    " To carry out a knowledge item (K-) the user applied from your recommendations card, pass only `item` with its id: geniro writes the text on the card, since pressing Apply was the user's review, and the document is live at once. " +
    `Then record it with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
