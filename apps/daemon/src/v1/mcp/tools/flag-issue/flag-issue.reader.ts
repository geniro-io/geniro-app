import { z } from 'zod';

import {
  AGENT_FLAG_DETAIL_MAX,
  AGENT_FLAG_MINUTES_MAX,
  AGENT_FLAG_SUMMARY_MAX,
  AgentFlagCategorySchema,
  AgentFlagCostSchema,
  type FlagIssueInput,
  type FlagIssueOutcome,
  hasControlCharacters,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

export const FlagIssueArgsSchema = z
  .object({
    cost: AgentFlagCostSchema,
    category: AgentFlagCategorySchema,
    summary: z.string().trim().min(1, 'summary is empty'),
    detail: z.string().trim().optional(),
    minutesLost: z.number().int().min(1).max(AGENT_FLAG_MINUTES_MAX).optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readFlagIssue(
  args: Record<string, unknown>,
): FlagIssueInput | { error: string } {
  const read = readToolArgs(FlagIssueArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  const { cost, category, summary, minutesLost } = read.query;
  const detail = read.query.detail || null;
  if (summary.length > AGENT_FLAG_SUMMARY_MAX) {
    return {
      error: `TOO_LONG: summary is over ${AGENT_FLAG_SUMMARY_MAX} characters`,
    };
  }
  if (detail !== null && detail.length > AGENT_FLAG_DETAIL_MAX) {
    return {
      error: `TOO_LONG: detail is over ${AGENT_FLAG_DETAIL_MAX} characters`,
    };
  }
  if (
    hasControlCharacters(summary) ||
    (detail !== null && hasControlCharacters(detail))
  ) {
    return {
      error: 'CONTROL_CHARACTERS: summary and detail must be plain text',
    };
  }
  if (cost === 'work' && minutesLost === undefined) {
    return {
      error:
        'MINUTES_REQUIRED: a flag that cost work says roughly how many minutes it cost (minutesLost)',
    };
  }
  return {
    cost,
    category,
    summary,
    detail,
    minutesLost: minutesLost ?? null,
  };
}

/** The receipt for a call the broker answered. */
export function flagIssueResultText(
  outcome: FlagIssueOutcome | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not recorded: ${outcome.reason}.`;
  }
  if (outcome.status === 'refused') {
    return `${outcome.code}: ${outcome.reason}.`;
  }
  return `Flag ${outcome.handle} recorded. Every analysis of this thread reads it first. This conversation may raise ${outcome.flagsLeft} more.`;
}
