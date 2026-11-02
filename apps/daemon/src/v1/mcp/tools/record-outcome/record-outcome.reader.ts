import { z } from 'zod';

import {
  RunOutcomeAcceptanceSchema,
  type RunOutcomeInput,
  type RunOutcomeWriteOutcome,
  THREAD_OUTCOME_SUMMARY_MAX,
  type ThreadOutcomeInput,
  ThreadOutcomeKindSchema,
  type ThreadOutcomeWriteOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { hasHiddenText } from '../../../agents/utils/hidden-text';
import { readToolArgs } from '../tool-args';

/** Far past any real pull request URL; refused rather than stored in a ledger that is never pruned. */
const PR_URL_MAX = 2048;
/** A few sentences; refused past it, never cut. */
export const OUTCOME_SUMMARY_MAX = 1000;

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
    summary: z
      .string()
      .trim()
      .max(
        OUTCOME_SUMMARY_MAX,
        `summary is over ${OUTCOME_SUMMARY_MAX} characters`,
      )
      .optional(),
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
    summary: read.query.summary || null,
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
  if (outcome.status === 'unchanged') {
    return `Unchanged: outcome ${outcome.seq} already records this draft state, review rounds and acceptance for the pull request, so nothing was written.`;
  }
  return `Recorded as outcome ${outcome.seq} (${outcome.questionsAsked} ${outcome.questionsAsked === 1 ? 'question' : 'questions'} asked of the user on this run so far).`;
}

const ThreadOutcomeArgsSchema = z
  .object({
    outcome: ThreadOutcomeKindSchema,
    summary: z
      .string()
      .trim()
      .min(
        1,
        'summary is required with outcome: say in a sentence or three what was done and what is left',
      )
      .max(
        THREAD_OUTCOME_SUMMARY_MAX,
        `summary is over ${THREAD_OUTCOME_SUMMARY_MAX} characters`,
      )
      .refine(
        (summary) => !hasHiddenText(summary, true),
        'summary holds a control or format character',
      ),
  })
  .strict();

/** Whether a call records how the thread ended rather than a pull request. */
export function isThreadOutcomeCall(args: Record<string, unknown>): boolean {
  return args.outcome !== undefined && args.outcome !== null;
}

/** A thread outcome call's arguments, or what is wrong with them. Never throws. */
export function readThreadOutcomeCall(
  args: Record<string, unknown>,
): ThreadOutcomeInput | { error: string } {
  const read = readToolArgs(ThreadOutcomeArgsSchema, args);
  if (!read.ok) {
    return {
      error: `${read.error} — a thread outcome takes only "outcome" and "summary"; record a pull request in a call of its own`,
    };
  }
  return { kind: read.query.outcome, summary: read.query.summary };
}

/** The receipt for a thread outcome that was not refused. */
export function threadOutcomeResultText(
  outcome:
    | Exclude<ThreadOutcomeWriteOutcome, { status: 'refused' }>
    | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not recorded: ${outcome.reason}.`;
  }
  return outcome.status === 'unchanged'
    ? `Unchanged: outcome ${outcome.seq} already records this, so nothing was written.`
    : `Recorded as the thread's outcome ${outcome.seq}.`;
}
