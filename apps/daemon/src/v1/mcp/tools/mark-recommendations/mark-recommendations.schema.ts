import { RecommendationMarksSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `mark_recommendations`'s arguments — generated from the schema they are parsed with. */
export function markRecommendationsSchema(): Record<string, unknown> {
  return toolInputSchema(RecommendationMarksSchema);
}
