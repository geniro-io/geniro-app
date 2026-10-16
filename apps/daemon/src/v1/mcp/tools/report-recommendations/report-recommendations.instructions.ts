import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  MAX_RECOMMENDATIONS_PER_TARGET,
} from '../../../agents/chat.types';

/** What a model reads about `report_recommendations`. */
export function reportRecommendationsInstructions(): string {
  return (
    "Post the analysis's recommendations as a card the user ticks and applies. " +
    `Use it when you have finished analysing the thread with ${HOST_ANALYZED_THREAD_TOOL}: call it ONCE with every recommendation, and do not also list them in your reply — the user sees the card. ` +
    `Each item needs evidence: seqs that exist in the analysed thread, each with a verbatim quote. At most ${MAX_RECOMMENDATIONS_PER_TARGET} items per target; an empty list is a valid report and means the thread ran efficiently. ` +
    "Ids are W-1, W-2… for workflow items (workflow threads only), R-1, R-2… for repo items and U-1, U-2… for a user's own instruction file the read lists under `userInstructions`. " +
    `Do NOT use it for code-review defects — that is ${HOST_FINDINGS_TOOL}. Do not apply anything until the user presses Apply; afterwards record what happened with ${HOST_RECOMMENDATION_MARKS_TOOL}. ` +
    "The result is a short receipt naming the card's seq."
  );
}
