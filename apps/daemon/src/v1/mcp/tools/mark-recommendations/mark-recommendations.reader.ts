import {
  type AnalysisFiled,
  type RecommendationMarks,
  RecommendationMarksSchema,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `mark_recommendations` call's outcomes, or why they cannot be read. */
export function readRecommendationMarks(
  args: Record<string, unknown>,
): ToolArgs<RecommendationMarks> {
  return readToolArgs(RecommendationMarksSchema.strict(), args);
}

export function marksResultText(outcome: AnalysisFiled | HostSinkUnavailable): {
  text: string;
  isError: boolean;
} {
  if (outcome.status === 'unavailable') {
    return {
      text: `The outcomes could not be recorded (${outcome.reason}). Say them in your reply instead.`,
      isError: true,
    };
  }
  if (outcome.status === 'refused') {
    return { text: `Not recorded: ${outcome.reason}.`, isError: true };
  }
  const noun = outcome.count === 1 ? 'outcome' : 'outcomes';
  return {
    text: `${outcome.count} ${noun} recorded on the card.`,
    isError: false,
  };
}
