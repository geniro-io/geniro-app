import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import type { ReviewCommentsOutcome, ReviewCommentsWire } from '../chat.types';

/** A review-comment write as the HTTP route answers it: the list, or the refusal as its status code. */
export function reviewCommentsOrThrow(
  outcome: ReviewCommentsOutcome,
): ReviewCommentsWire {
  if (outcome.status === 'ok') {
    return { comments: outcome.comments };
  }
  switch (outcome.code) {
    case 'RUN_NOT_FOUND':
    case 'REVIEW_COMMENT_NOT_FOUND':
      throw new NotFoundException(outcome.code, outcome.reason);
    case 'RUN_ARCHIVED':
    case 'REVIEW_COMMENT_NOT_DRAFT':
    case 'REVIEW_COMMENT_NOT_SENT':
      throw new ConflictException(outcome.code, outcome.reason);
    default:
      throw new BadRequestException(outcome.code, outcome.reason);
  }
}
