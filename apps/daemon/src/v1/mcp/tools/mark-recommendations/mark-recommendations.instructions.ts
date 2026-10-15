import { HOST_RECOMMENDATIONS_TOOL } from '../../../agents/chat.types';

/** What a model reads about `mark_recommendations`. */
export function markRecommendationsInstructions(): string {
  return (
    `Record what happened to each recommendation the user applied from a ${HOST_RECOMMENDATIONS_TOOL} card, so the card shows it. ` +
    "Use it when you have finished applying the items an Apply message listed: call it ONCE with the card's seq and an outcome for every selected item — applied (with the backup name for a workflow save), failed (with the reason) or skipped (with the reason). " +
    'Do NOT use it for items the user did not select, or before you have actually tried them. ' +
    'The result is a short receipt.'
  );
}
