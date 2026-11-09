import { z } from 'zod';

import {
  type AnalysisFiled,
  type RecommendationsCall,
  RecommendationsPatchSchema,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

const PatchCallSchema = z
  .object({ patch: RecommendationsPatchSchema })
  .strict();

/**
 * A `report_recommendations` call, or why its patch cannot be read. A whole card
 * stays as sent: the service parses it, so one that fails the schema is kept for
 * a patch like one that fails the other checks.
 */
export function readRecommendationsCall(
  args: Record<string, unknown>,
): ToolArgs<RecommendationsCall> {
  if (args.patch === undefined || args.patch === null) {
    return {
      ok: true,
      query: {
        whole: Object.fromEntries(
          Object.entries(args).filter(([, value]) => value !== null),
        ),
      },
    };
  }
  return readToolArgs(PatchCallSchema, args);
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
  const members =
    outcome.members === undefined
      ? ''
      : ` and ${outcome.members} member ${outcome.members === 1 ? 'assessment' : 'assessments'}`;
  return {
    text: `Card recorded at seq ${outcome.seq} with ${outcome.count} ${noun}${members} and shown to the user. Change nothing until they apply.`,
    isError: false,
  };
}
