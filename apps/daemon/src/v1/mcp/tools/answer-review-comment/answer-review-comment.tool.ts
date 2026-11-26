import { Logger } from '@nestjs/common';

import { HOST_ANSWER_REVIEW_COMMENT_TOOL } from '../../../agents/chat.types';
import type { ReviewCommentsService } from '../../../agents/services/review-comments.service';
import type { McpCallContext, McpToolResult } from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { answerReviewCommentInstructions } from './answer-review-comment.instructions';
import {
  answerReviewCommentResultText,
  readAnswerReviewComment,
} from './answer-review-comment.reader';
import { answerReviewCommentSchema } from './answer-review-comment.schema';

/**
 * `answer_review_comment` — the agent's answer to one comment the user sent
 * from the changes screen, shown under that comment. Offered in every run.
 */
export class AnswerReviewCommentTool extends BaseMcpTool {
  readonly name = HOST_ANSWER_REVIEW_COMMENT_TOOL;
  private readonly logger = new Logger(AnswerReviewCommentTool.name);

  constructor(private readonly reviews: ReviewCommentsService) {
    super();
  }

  protected isOffered(): boolean {
    return true;
  }

  protected instructions(): string {
    return answerReviewCommentInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return answerReviewCommentSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const call = readAnswerReviewComment(args);
    if ('error' in call) {
      return this.invalidArgs(call.error);
    }
    try {
      const outcome = await this.reviews.answer(runId, { memberId }, call);
      const reply = answerReviewCommentResultText(outcome);
      return this.answerTo(outcome, reply.text, reply.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not answer review comment #${call.comment}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.failedInGeniro(
        'Not answered: the answer could not be saved.',
      );
    }
  }
}
