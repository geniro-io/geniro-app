import { toolInputSchema } from '../tool-args';
import { AnswerReviewCommentArgsSchema } from './answer-review-comment.reader';

/** `answer_review_comment`'s arguments, generated from the schema the reader holds them to. */
export function answerReviewCommentSchema(): Record<string, unknown> {
  return toolInputSchema(
    AnswerReviewCommentArgsSchema.extend({
      comment: AnswerReviewCommentArgsSchema.shape.comment.describe(
        'The comment\'s number, as the review message names it (#3 → 3).',
      ),
      reply: AnswerReviewCommentArgsSchema.shape.reply.describe(
        'What you did about it, or why you did not, in a sentence or two; shown under the comment.',
      ),
      status: AnswerReviewCommentArgsSchema.shape.status.describe(
        'fixed when the change it asks for is made, not_fixed when you did not make it (say why in the reply).',
      ),
    }),
  );
}
