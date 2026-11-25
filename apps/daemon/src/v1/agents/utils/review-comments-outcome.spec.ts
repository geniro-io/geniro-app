import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ReviewCommentRefusalCode } from '../chat.types';
import { reviewCommentsOrThrow } from './review-comments-outcome';

const STATUS: Record<
  ReviewCommentRefusalCode,
  new (...args: never[]) => Error
> = {
  RUN_NOT_FOUND: NotFoundException,
  REVIEW_COMMENT_NOT_FOUND: NotFoundException,
  RUN_ARCHIVED: ConflictException,
  REVIEW_COMMENT_NOT_DRAFT: ConflictException,
  REVIEW_COMMENT_NOT_SENT: ConflictException,
  REVIEW_COMMENT_EMPTY: BadRequestException,
  REVIEW_COMMENT_TOO_LONG: BadRequestException,
  REVIEW_COMMENT_BAD_RANGE: BadRequestException,
};

describe('reviewCommentsOrThrow', () => {
  it('answers the list for a write that went through', () => {
    expect(
      reviewCommentsOrThrow({ status: 'ok', comments: [], changed: [] }),
    ).toEqual({ comments: [] });
  });

  for (const [code, exception] of Object.entries(STATUS)) {
    it(`answers ${code} as ${exception.name}`, () => {
      expect(() =>
        reviewCommentsOrThrow({
          status: 'refused',
          code: code as ReviewCommentRefusalCode,
          reason: 'why',
        }),
      ).toThrow(exception);
    });
  }
});
