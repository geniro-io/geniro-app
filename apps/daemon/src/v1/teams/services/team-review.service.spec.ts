import { describe, expect, it, vi } from 'vitest';

import type { ItemWire, ReviewMessage } from '../../agents/chat.types';
import type { ReviewCommentsService } from '../../agents/services/review-comments.service';
import type { TeamExecutorService } from './team-executor.service';
import { TeamReviewService } from './team-review.service';

const MESSAGE: ReviewMessage = {
  text: 'Review of your changes — 1 comment in 1 file.',
  storedText: 'Review of your changes — 1 comment in 1 file.',
  review: { note: null, comments: [] },
  clientMessageId: 'm-1',
};

describe('TeamReviewService', () => {
  it('sends the review to the run as a turn of its own, with the review on the user’s row', async () => {
    const row = { seq: 4 } as ItemWire;
    const sendMessage = vi.fn(async () => row);
    const send = vi.fn(
      async (
        _runId: string,
        _input: unknown,
        deliver: (message: ReviewMessage) => Promise<ItemWire>,
      ) => ({ seq: (await deliver(MESSAGE)).seq, sent: 1 }),
    );
    const service = new TeamReviewService(
      { send } as unknown as ReviewCommentsService,
      { sendMessage } as unknown as TeamExecutorService,
    );

    const result = await service.send('run-1', {
      clientMessageId: 'm-1',
      note: null,
    });

    expect(result).toEqual({ seq: 4, sent: 1 });
    expect(send).toHaveBeenCalledWith(
      'run-1',
      { clientMessageId: 'm-1', note: null },
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'run-1',
      MESSAGE.text,
      [],
      'm-1',
      undefined,
      MESSAGE.storedText,
      { payload: MESSAGE.review, ownTurn: true },
    );
  });
});
