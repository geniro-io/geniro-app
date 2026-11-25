import { describe, expect, it } from 'vitest';

import { reviewCommentsDb } from '../../../agents/__tests__/review-comments-db';
import type {
  ItemWire,
  ReviewCommentsOutcome,
} from '../../../agents/chat.types';
import { answerReviewCommentResultText } from './answer-review-comment.reader';

const DRAFT = {
  folder: '/work/shop',
  path: 'src/cart/checkout.ts',
  side: 'new' as const,
  startLine: 12,
  endLine: 12,
  quote: 'const total = 0;',
  body: 'Extract the sum into a function.',
};

function refusedOf(outcome: ReviewCommentsOutcome) {
  if (outcome.status !== 'refused') {
    throw new Error('expected a refusal');
  }
  return outcome;
}

describe('answerReviewCommentResultText', () => {
  it('answers ok for a sent comment and gives the reason for a draft, a resolved, a deleted and an unknown number', async () => {
    const db = await reviewCommentsDb();
    try {
      await db.seedRun('run-1');
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const added = await db.service.add('run-1', {
          ...DRAFT,
          startLine: i + 1,
          endLine: i + 1,
        });
        if (added.status !== 'ok') {
          throw new Error('add refused');
        }
        ids.push(added.changed[0]!.id);
      }
      const deliver = async () => ({ seq: 9 }) as ItemWire;
      await db.service.send(
        'run-1',
        { clientMessageId: 'm-1', note: null },
        deliver,
      );
      const draft = await db.service.add('run-1', {
        ...DRAFT,
        startLine: 40,
        endLine: 40,
      });
      if (draft.status !== 'ok') {
        throw new Error('add refused');
      }
      await db.service.setStatus('run-1', ids[2]!, 'resolved');
      await db.service.remove('run-1', ids[3]!);

      const answer = (comment: number) =>
        db.service.answer(
          'run-1',
          { memberId: 'dev' },
          { comment, reply: 'Done.', status: 'fixed' },
        );

      const sentOutcome = await answer(1);
      expect(sentOutcome.status).toBe('ok');
      expect(answerReviewCommentResultText(sentOutcome)).toEqual({
        text: expect.any(String),
        isError: false,
      });

      const draftRefusal = refusedOf(await answer(5));
      expect(draftRefusal.code).toBe('REVIEW_COMMENT_NOT_SENT');
      expect(answerReviewCommentResultText(draftRefusal)).toEqual({
        text: expect.stringContaining(draftRefusal.reason),
        isError: true,
      });

      const resolvedRefusal = refusedOf(await answer(3));
      expect(resolvedRefusal.code).toBe('REVIEW_COMMENT_NOT_SENT');
      expect(answerReviewCommentResultText(resolvedRefusal)).toEqual({
        text: expect.stringContaining(resolvedRefusal.reason),
        isError: true,
      });

      const deletedRefusal = refusedOf(await answer(4));
      expect(answerReviewCommentResultText(deletedRefusal)).toEqual({
        text: expect.stringContaining(deletedRefusal.reason),
        isError: true,
      });

      const unknownRefusal = refusedOf(await answer(99));
      expect(unknownRefusal.code).toBe('REVIEW_COMMENT_NOT_FOUND');
      expect(answerReviewCommentResultText(unknownRefusal)).toEqual({
        text: expect.stringContaining(unknownRefusal.reason),
        isError: true,
      });
    } finally {
      await db.orm.close(true);
    }
  });

  it('lists as unanswered only sent comments the agent never answered, not one the user reopened', async () => {
    const db = await reviewCommentsDb();
    try {
      await db.seedRun('run-1');
      for (let line = 1; line <= 3; line += 1) {
        await db.service.add('run-1', {
          ...DRAFT,
          startLine: line,
          endLine: line,
        });
      }
      await db.service.send(
        'run-1',
        { clientMessageId: 'm-1', note: null },
        async () => ({ seq: 9 }) as ItemWire,
      );
      await db.service.answer(
        'run-1',
        { memberId: null },
        { comment: 1, reply: 'Done.', status: 'fixed' },
      );
      const listed = await db.service.list('run-1');
      await db.service.setStatus('run-1', listed![0]!.id, 'sent');

      const outcome = await db.service.answer(
        'run-1',
        { memberId: null },
        { comment: 2, reply: 'Done too.', status: 'fixed' },
      );

      const { text, isError } = answerReviewCommentResultText(outcome);
      expect(isError).toBe(false);
      expect(text).toContain('Answered #2 as fixed');
      expect(text).toContain('Still unanswered: #3.');
    } finally {
      await db.orm.close(true);
    }
  });
});
