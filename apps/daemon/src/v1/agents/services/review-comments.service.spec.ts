import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reviewCommentsDb } from '../__tests__/review-comments-db';
import type { ReviewCommentsOutcome } from '../chat.types';
import { composeReviewText } from '../utils/review-message';

type Db = Awaited<ReturnType<typeof reviewCommentsDb>>;
type Deliver = Parameters<Db['service']['send']>[2];
type DeliverMessage = Parameters<Deliver>[0];
type DeliverResult = Awaited<ReturnType<Deliver>>;

function accepting(seq = 9) {
  return vi.fn(async (_message: DeliverMessage) => ({ seq }) as DeliverResult);
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function ok(outcome: ReviewCommentsOutcome) {
  if (outcome.status !== 'ok') {
    throw new Error('refused: ' + outcome.code + ' ' + outcome.reason);
  }
  return outcome;
}

function refusal(outcome: ReviewCommentsOutcome) {
  if (outcome.status !== 'refused') {
    throw new Error('expected a refusal');
  }
  return outcome;
}

const DRAFT = {
  folder: '/work/shop',
  path: 'src/cart/checkout.ts',
  side: 'new' as const,
  startLine: 12,
  endLine: 12,
  quote: 'const total = 0;',
  body: 'Extract the sum into a function.',
};

describe('ReviewCommentsService — the comments of a review', () => {
  let db: Db;

  beforeEach(async () => {
    db = await reviewCommentsDb();
    await db.seedRun('run-1');
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  it('adds a draft under the next number, numbering each run on its own', async () => {
    const first = ok(await db.service.add('run-1', DRAFT));
    const second = ok(
      await db.service.add('run-1', { ...DRAFT, startLine: 30, endLine: 30 }),
    );
    await db.seedRun('run-2');
    const other = ok(await db.service.add('run-2', DRAFT));

    expect(first.changed[0]).toMatchObject({
      number: 1,
      status: 'draft',
      sentSeq: null,
    });
    expect(second.changed[0]!.number).toBe(2);
    expect(other.changed[0]!.number).toBe(1);
  });

  it('changes the body of a draft', async () => {
    const added = ok(await db.service.add('run-1', DRAFT));
    const id = added.changed[0]!.id;

    const edited = ok(await db.service.edit('run-1', id, 'Use a helper.'));

    expect(edited.changed[0]).toMatchObject({ id, body: 'Use a helper.' });
  });

  it('refuses to edit a comment once it is sent', async () => {
    const added = ok(await db.service.add('run-1', DRAFT));
    await db.service.send(
      'run-1',
      { clientMessageId: 'm-1', note: null },
      accepting(),
    );

    const outcome = await db.service.edit(
      'run-1',
      added.changed[0]!.id,
      'Too late.',
    );

    expect(refusal(outcome).code).toBe('REVIEW_COMMENT_NOT_DRAFT');
  });

  it('refuses an empty body, on add and on edit', async () => {
    expect(
      refusal(await db.service.add('run-1', { ...DRAFT, body: '   ' })).code,
    ).toBe('REVIEW_COMMENT_EMPTY');
    const added = ok(await db.service.add('run-1', DRAFT));

    expect(
      refusal(await db.service.edit('run-1', added.changed[0]!.id, '')).code,
    ).toBe('REVIEW_COMMENT_EMPTY');
  });

  it('refuses a body over 4000 characters, and keeps one of exactly 4000', async () => {
    expect(
      refusal(
        await db.service.add('run-1', { ...DRAFT, body: 'x'.repeat(4001) }),
      ).code,
    ).toBe('REVIEW_COMMENT_TOO_LONG');
    expect(
      ok(await db.service.add('run-1', { ...DRAFT, body: 'x'.repeat(4000) }))
        .changed[0],
    ).toMatchObject({ body: 'x'.repeat(4000) });
  });

  it('removes a comment from the list, whatever its status', async () => {
    const added = ok(await db.service.add('run-1', DRAFT));

    ok(await db.service.remove('run-1', added.changed[0]!.id));

    expect(await db.service.list('run-1')).toEqual([]);
  });

  it('refuses a comment id the run does not have', async () => {
    expect(
      refusal(await db.service.edit('run-1', 'no-such-comment', 'x')).code,
    ).toBe('REVIEW_COMMENT_NOT_FOUND');
    expect(
      refusal(await db.service.remove('run-1', 'no-such-comment')).code,
    ).toBe('REVIEW_COMMENT_NOT_FOUND');
  });

  it('refuses a run that is not there, and one that is archived', async () => {
    expect(refusal(await db.service.add('gone', DRAFT))).toMatchObject({
      code: 'RUN_NOT_FOUND',
    });

    await db.seedRun('run-archived', { archivedAt: new Date() });
    expect(refusal(await db.service.add('run-archived', DRAFT))).toMatchObject({
      code: 'RUN_ARCHIVED',
    });
  });

  it('announces every write it makes to the run’s review', async () => {
    const spy = vi.spyOn(db.bus, 'publishReviewCommentsChanged');
    const announcesBefore = () => spy.mock.calls.length;

    const before = announcesBefore();
    const added = ok(await db.service.add('run-1', DRAFT));
    expect(announcesBefore()).toBeGreaterThan(before);
    expect(spy).toHaveBeenLastCalledWith('run-1');

    const beforeEdit = announcesBefore();
    ok(await db.service.edit('run-1', added.changed[0]!.id, 'Edited.'));
    expect(announcesBefore()).toBeGreaterThan(beforeEdit);
    expect(spy).toHaveBeenLastCalledWith('run-1');

    const beforeRemove = announcesBefore();
    ok(await db.service.remove('run-1', added.changed[0]!.id));
    expect(announcesBefore()).toBeGreaterThan(beforeRemove);
    expect(spy).toHaveBeenLastCalledWith('run-1');
  });
});

describe('ReviewCommentsService — sending the review', () => {
  let db: Db;

  beforeEach(async () => {
    db = await reviewCommentsDb();
    await db.seedRun('run-1');
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  it('delivers the drafts once as one message, then marks them sent with the row’s seq', async () => {
    ok(await db.service.add('run-1', DRAFT));
    ok(
      await db.service.add('run-1', {
        ...DRAFT,
        path: 'src/cart/discount.ts',
        startLine: 3,
        endLine: 4,
        quote: 'return row.percent;',
        body: 'Clamp the discount.',
      }),
    );
    const deliver = accepting(9);

    const result = await db.service.send(
      'run-1',
      { clientMessageId: 'm-1', note: 'Please look at both.' },
      deliver,
    );

    expect(deliver).toHaveBeenCalledTimes(1);
    const message = deliver.mock.calls[0]![0];
    expect(message.clientMessageId).toBe('m-1');
    expect(message.review.note).toBe('Please look at both.');
    expect(message.review.comments).toHaveLength(2);
    expect(message.text).toBe(
      composeReviewText(
        'Please look at both.',
        message.review.comments,
        '/work/shop',
      ),
    );
    expect(result).toEqual({ seq: 9, sent: 2 });
    expect(
      (await db.service.list('run-1'))!.map((c) => [c.status, c.sentSeq]),
    ).toEqual([
      ['sent', 9],
      ['sent', 9],
    ]);
  });

  it('leaves every draft a draft when the turn is busy, and lets the refusal through', async () => {
    const added = ok(await db.service.add('run-1', DRAFT));
    const deliver = vi.fn(async (): Promise<never> => {
      throw new ConflictException('RUN_BUSY');
    });

    await expect(
      db.service.send('run-1', { clientMessageId: 'm-1', note: null }, deliver),
    ).rejects.toBeInstanceOf(ConflictException);

    const after = await db.service.list('run-1');
    expect(after!.map((c) => [c.id, c.status])).toEqual([
      [added.changed[0]!.id, 'draft'],
    ]);
  });

  it('refuses a send with no drafts, and a second send once everything is sent', async () => {
    const deliver = accepting();
    const error1 = await thrownBy(
      db.service.send('run-1', { clientMessageId: 'm-0', note: null }, deliver),
    );
    expect(error1).toBeInstanceOf(BadRequestException);
    expect(error1).toMatchObject({ errorCode: 'REVIEW_EMPTY' });
    expect(deliver).not.toHaveBeenCalled();

    ok(await db.service.add('run-1', DRAFT));
    await db.service.send(
      'run-1',
      { clientMessageId: 'm-1', note: null },
      accepting(),
    );

    const error2 = await thrownBy(
      db.service.send('run-1', { clientMessageId: 'm-2', note: null }, deliver),
    );
    expect(error2).toBeInstanceOf(BadRequestException);
    expect(error2).toMatchObject({ errorCode: 'REVIEW_EMPTY' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses more than 50 drafts', async () => {
    for (let i = 0; i < 51; i += 1) {
      ok(
        await db.service.add('run-1', {
          ...DRAFT,
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    }
    const deliver = accepting();

    const error3 = await thrownBy(
      db.service.send('run-1', { clientMessageId: 'm-1', note: null }, deliver),
    );
    expect(error3).toBeInstanceOf(BadRequestException);
    expect(error3).toMatchObject({ errorCode: 'REVIEW_TOO_LARGE' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (await db.service.list('run-1'))!.every((c) => c.status === 'draft'),
    ).toBe(true);
  });

  it('sends exactly 50 drafts', async () => {
    for (let i = 0; i < 50; i += 1) {
      ok(
        await db.service.add('run-1', {
          ...DRAFT,
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    }

    expect(
      await db.service.send(
        'run-1',
        { clientMessageId: 'm-1', note: null },
        accepting(),
      ),
    ).toEqual({ seq: 9, sent: 50 });
  });

  it('replays the stored row for a clientMessageId already delivered, without delivering again', async () => {
    ok(await db.service.add('run-1', DRAFT));
    ok(await db.service.add('run-1', { ...DRAFT, startLine: 30, endLine: 30 }));
    const snapshot = (number: number) => ({
      number,
      folder: '/work/shop',
      path: 'src/cart/checkout.ts',
      side: 'new',
      startLine: 12,
      endLine: 12,
      quote: 'const total = 0;',
      body: 'Extract the sum into a function.',
    });
    await db.seedUserMessage('run-1', 12, {
      text: 'Review of your changes',
      clientMessageId: 'm-9',
      review: { note: null, comments: [snapshot(1), snapshot(2)] },
    });
    const deliver = accepting();

    expect(
      await db.service.send(
        'run-1',
        { clientMessageId: 'm-9', note: null },
        deliver,
      ),
    ).toEqual({ seq: 12, sent: 2 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('throws the run’s own refusal when the run is not there, or is archived', async () => {
    await expect(
      db.service.send(
        'gone',
        { clientMessageId: 'm-1', note: null },
        accepting(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await db.seedRun('run-archived', { archivedAt: new Date() });
    await expect(
      db.service.send(
        'run-archived',
        { clientMessageId: 'm-1', note: null },
        accepting(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ReviewCommentsService — the agent’s answers', () => {
  let db: Db;

  beforeEach(async () => {
    db = await reviewCommentsDb();
    await db.seedRun('run-1');
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  async function sendOne(): Promise<void> {
    ok(await db.service.add('run-1', DRAFT));
    await db.service.send(
      'run-1',
      { clientMessageId: 'm-1', note: null },
      accepting(),
    );
  }

  it('writes the reply, its status, the time and the member onto a sent comment', async () => {
    await sendOne();

    const answered = ok(
      await db.service.answer(
        'run-1',
        { memberId: 'dev' },
        { comment: 1, reply: 'Moved the sum into a helper.', status: 'fixed' },
      ),
    );

    expect(answered.changed).toEqual([
      expect.objectContaining({
        number: 1,
        status: 'sent',
        agentStatus: 'fixed',
        agentReply: 'Moved the sum into a helper.',
        agentMemberId: 'dev',
        agentRepliedAt: expect.any(String),
      }),
    ]);

    const declined = ok(
      await db.service.answer(
        'run-1',
        { memberId: 'dev' },
        { comment: 1, reply: 'Not possible here.', status: 'not_fixed' },
      ),
    );
    expect(declined.changed[0]).toMatchObject({
      agentStatus: 'not_fixed',
      agentReply: 'Not possible here.',
    });
  });

  it('refuses an answer on a draft', async () => {
    ok(await db.service.add('run-1', DRAFT));

    expect(
      refusal(
        await db.service.answer(
          'run-1',
          { memberId: 'dev' },
          { comment: 1, reply: 'Done.', status: 'fixed' },
        ),
      ).code,
    ).toBe('REVIEW_COMMENT_NOT_SENT');
  });

  it('refuses an answer on a resolved comment', async () => {
    await sendOne();
    const [comment] = (await db.service.list('run-1'))!;
    ok(await db.service.setStatus('run-1', comment!.id, 'resolved'));

    expect(
      refusal(
        await db.service.answer(
          'run-1',
          { memberId: 'dev' },
          { comment: 1, reply: 'Done.', status: 'fixed' },
        ),
      ).code,
    ).toBe('REVIEW_COMMENT_NOT_SENT');
  });

  it('refuses an answer on a deleted comment', async () => {
    await sendOne();
    const [comment] = (await db.service.list('run-1'))!;
    ok(await db.service.remove('run-1', comment!.id));

    expect(
      refusal(
        await db.service.answer(
          'run-1',
          { memberId: 'dev' },
          { comment: 1, reply: 'Done.', status: 'fixed' },
        ),
      ).status,
    ).toBe('refused');
  });

  it('refuses a number no comment of the run has', async () => {
    await sendOne();

    expect(
      refusal(
        await db.service.answer(
          'run-1',
          { memberId: 'dev' },
          { comment: 9, reply: 'Done.', status: 'fixed' },
        ),
      ).code,
    ).toBe('REVIEW_COMMENT_NOT_FOUND');
  });

  it('refuses a status change on a draft', async () => {
    const added = ok(await db.service.add('run-1', DRAFT));

    expect(
      refusal(
        await db.service.setStatus('run-1', added.changed[0]!.id, 'resolved'),
      ).code,
    ).toBe('REVIEW_COMMENT_NOT_SENT');
  });

  it('clears the agent’s status when a resolved comment is reopened, and keeps its reply', async () => {
    await sendOne();
    ok(
      await db.service.answer(
        'run-1',
        { memberId: 'dev' },
        { comment: 1, reply: 'Moved it.', status: 'fixed' },
      ),
    );
    const [comment] = (await db.service.list('run-1'))!;

    ok(await db.service.setStatus('run-1', comment!.id, 'resolved'));
    const reopened = ok(
      await db.service.setStatus('run-1', comment!.id, 'sent'),
    );

    expect(reopened.changed[0]).toMatchObject({
      status: 'sent',
      agentStatus: null,
      agentReply: 'Moved it.',
    });
  });
});
