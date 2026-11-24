import { z } from 'zod';

import {
  REVIEW_COMMENT_MAX_CHARS,
  ReviewAgentStatusSchema,
  type ReviewCommentsOutcome,
} from '../../../agents/chat.types';
import { hasHiddenText } from '../../../agents/utils/hidden-text';
import { readToolArgs } from '../tool-args';

export const AnswerReviewCommentArgsSchema = z
  .object({
    comment: z.number().int().min(1),
    reply: z
      .string()
      .trim()
      .min(1, 'the reply is empty — say what you did')
      .max(
        REVIEW_COMMENT_MAX_CHARS,
        `the reply is over ${REVIEW_COMMENT_MAX_CHARS} characters — say what you did, not the diff`,
      )
      .refine(
        (reply) => !hasHiddenText(reply, true),
        'the reply holds a control or format character',
      ),
    status: ReviewAgentStatusSchema,
  })
  .strict();

export type AnswerReviewCommentCall = z.infer<
  typeof AnswerReviewCommentArgsSchema
>;

/** The call, or what is wrong with it. Never throws. */
export function readAnswerReviewComment(
  args: Record<string, unknown>,
): AnswerReviewCommentCall | { error: string } {
  const read = readToolArgs(AnswerReviewCommentArgsSchema, args);
  return read.ok ? read.query : { error: read.error };
}

/** The receipt the agent reads back. */
export function answerReviewCommentResultText(outcome: ReviewCommentsOutcome): {
  text: string;
  isError: boolean;
} {
  if (outcome.status === 'refused') {
    return {
      text: `Not answered (${outcome.code}): ${outcome.reason}.`,
      isError: true,
    };
  }
  const open = outcome.comments.filter(
    (comment) => comment.status === 'sent' && comment.agentStatus === null,
  );
  const left =
    open.length === 0
      ? 'Every sent comment has an answer now.'
      : `Still unanswered: ${open.map((comment) => `#${comment.number}`).join(', ')}.`;
  const answered = outcome.changed[0];
  return {
    text:
      answered === undefined
        ? left
        : `Answered #${answered.number} as ${answered.agentStatus ?? 'answered'}; the user sees it under their comment. ${left}`,
    isError: false,
  };
}
