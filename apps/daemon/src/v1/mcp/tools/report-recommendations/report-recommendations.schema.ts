import {
  RecommendationsPatchSchema,
  RecommendationsReportSchema,
} from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/**
 * `report_recommendations`'s arguments, generated from the schemas they are
 * parsed with. `hotspots` and `items` stop being required here only because a
 * patch carries neither: a whole card is still held to them.
 */
export function reportRecommendationsSchema(): Record<string, unknown> {
  return toolInputSchema(
    RecommendationsReportSchema.partial({
      hotspots: true,
      items: true,
    }).extend({
      patch: RecommendationsPatchSchema.optional().describe(
        'Instead of a whole card: what fixes the card this turn was refused. Send nothing else beside it. Every check runs again on the result',
      ),
    }),
  );
}
