import { z } from 'zod';

import {
  RunOutcomeAcceptanceSchema,
  type RunOutcomeInput,
  type RunOutcomeWriteOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

/** Far past any real pull request URL; refused rather than stored in a ledger that is never pruned. */
const PR_URL_MAX = 2048;

const RecordOutcomeArgsSchema = z
  .object({
    pr_number: z.number().int().min(1),
    pr_url: z
      .string()
      .trim()
      .min(1, 'pr_url is empty')
      .max(PR_URL_MAX, `pr_url is over ${PR_URL_MAX} characters`),
    draft: z.boolean(),
    review_rounds: z.number().int().min(0),
    acceptance: RunOutcomeAcceptanceSchema,
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readRecordOutcome(
  args: Record<string, unknown>,
): RunOutcomeInput | { error: string } {
  const read = readToolArgs(RecordOutcomeArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  return {
    prNumber: read.query.pr_number,
    prUrl: read.query.pr_url,
    draft: read.query.draft,
    reviewRounds: read.query.review_rounds,
    acceptance: read.query.acceptance,
  };
}

/** The receipt for a record that was not refused. */
export function recordOutcomeResultText(
  outcome:
    | Exclude<RunOutcomeWriteOutcome, { status: 'refused' }>
    | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not recorded: ${outcome.reason}.`;
  }
  return `Recorded as outcome ${outcome.seq} (${outcome.questionsAsked} ${outcome.questionsAsked === 1 ? 'question' : 'questions'} asked of the user on this run so far).`;
}
