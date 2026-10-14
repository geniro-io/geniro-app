import { RecommendationsReportSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `report_recommendations`'s arguments — generated from the schema they are parsed with. */
export function reportRecommendationsSchema(): Record<string, unknown> {
  return toolInputSchema(RecommendationsReportSchema);
}
