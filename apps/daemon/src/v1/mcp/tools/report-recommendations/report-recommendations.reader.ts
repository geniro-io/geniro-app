import {
  type AnalysisFiled,
  type RecommendationsReport,
  RecommendationsReportSchema,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `report_recommendations` call's report, or why it cannot be read. */
export function readRecommendationsReport(
  args: Record<string, unknown>,
): ToolArgs<RecommendationsReport> {
  return readToolArgs(RecommendationsReportSchema.strict(), args);
}

/** The receipt — never the items themselves, which are on the card. */
export function recommendationsResultText(
  outcome: AnalysisFiled | HostSinkUnavailable,
): { text: string; isError: boolean } {
  if (outcome.status === 'unavailable') {
    return {
      text: `The recommendations could not be recorded (${outcome.reason}). Write them in your reply instead.`,
      isError: true,
    };
  }
  if (outcome.status === 'refused') {
    return { text: `Not recorded: ${outcome.reason}.`, isError: true };
  }
  const noun = outcome.count === 1 ? 'recommendation' : 'recommendations';
  return {
    text: `Card recorded at seq ${outcome.seq} with ${outcome.count} ${noun} and shown to the user. Change nothing until they apply.`,
    isError: false,
  };
}
