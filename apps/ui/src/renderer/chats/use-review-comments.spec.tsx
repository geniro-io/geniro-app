// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTION_RETRY_MS } from './use-chat-actions';
import {
  type ReviewCommentInput,
  type ReviewController,
  useReviewComments,
} from './use-review-comments';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof useReviewComments>[0];

const INPUT: ReviewCommentInput = {
  folder: '/repo',
  path: 'src/a.ts',
  side: 'new',
  startLine: 3,
  endLine: 3,
  quote: 'const a = 1;',
  body: 'x'.repeat(4001),
};

function refusal(status: number, body: object): Error {
  return new Error(
    `daemon POST /v1/chats/run-1/review-comments failed (${status}): ${JSON.stringify(body)}`,
  );
}

function chatApi(overrides: Partial<NonNullable<Props['api']>> = {}) {
  return {
    listReviewComments: vi.fn(async () => ({ comments: [] })),
    addReviewComment: vi.fn(async () => ({ comments: [] })),
    editReviewComment: vi.fn(async () => ({ comments: [] })),
    deleteReviewComment: vi.fn(async () => ({ comments: [] })),
    sendChatReview: vi.fn(async () => ({ seq: 9, sent: 1 })),
    ...overrides,
  };
}

const EVENTS = {
  onReviewCommentsChanged: () => () => undefined,
  onReconnect: () => () => undefined,
} as unknown as NonNullable<Props['client']>;

let root: Root | null = null;
let seen: ReviewController | null = null;

function Probe(props: Props): null {
  seen = useReviewComments(props);
  return null;
}

async function render(props: Props): Promise<void> {
  if (root === null) {
    root = createRoot(document.createElement('div'));
  }
  await act(async () => {
    root!.render(<Probe {...props} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen = null;
  vi.useRealTimers();
});

describe('useReviewComments', () => {
  it('says why a comment was refused in words, never with the daemon’s envelope', async () => {
    const api = chatApi({
      addReviewComment: vi.fn(async () => {
        throw refusal(400, {
          code: 'REVIEW_COMMENT_TOO_LONG',
          message: 'the comment is too long — at most 4000 characters',
        });
      }),
    });
    await render({
      api,
      teamApi: null,
      client: EVENTS,
      runId: 'run-1',
      agentWorking: false,
    });

    let thrown: unknown = null;
    await act(async () => {
      await seen!.add(INPUT).catch((err: unknown) => {
        thrown = err;
      });
    });

    expect((thrown as Error).message).toBe(
      'The comment is too long — at most 4000 characters',
    );
    expect(seen!.error).toBe(
      'The comment is too long — at most 4000 characters',
    );
  });

  it('never shows the text it sent back when the daemon refuses it as invalid', async () => {
    const api = chatApi({
      addReviewComment: vi.fn(async () => {
        throw refusal(403, {
          code: 'VALIDATION_ERROR',
          message: 'Validation exceptions',
          fields: [{ name: 'body', value: INPUT.body }],
        });
      }),
    });
    await render({
      api,
      teamApi: null,
      client: EVENTS,
      runId: 'run-1',
      agentWorking: false,
    });

    let thrown: unknown = null;
    await act(async () => {
      await seen!.add(INPUT).catch((err: unknown) => {
        thrown = err;
      });
    });

    expect((thrown as Error).message).not.toContain('xxxx');
    expect((thrown as Error).message).not.toContain('{');
    expect(seen!.error).toBe((thrown as Error).message);
  });

  it('holds a review sent while the agent works, and sends it once the turn ends', async () => {
    const api = chatApi();
    const props: Props = {
      api,
      teamApi: null,
      client: EVENTS,
      runId: 'run-1',
      agentWorking: true,
    };
    await render(props);

    await act(async () => {
      await seen!.send('please');
    });

    expect(api.sendChatReview).not.toHaveBeenCalled();
    expect(seen!.sending).toBe('waiting');

    await render({ ...props, agentWorking: false });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(api.sendChatReview).toHaveBeenCalledTimes(1);
    expect(api.sendChatReview).toHaveBeenCalledWith({
      runId: 'run-1',
      sendReviewDto: { clientMessageId: expect.any(String), note: 'please' },
    });
    expect(seen!.sending).toBe('idle');
  });

  it('keeps a team review the run refused as busy, and sends it again with the same id', async () => {
    vi.useFakeTimers();
    const sendTeamReview = vi
      .fn()
      .mockRejectedValueOnce(
        refusal(409, { code: 'RUN_BUSY', message: 'a is in a turn' }),
      )
      .mockResolvedValueOnce({ seq: 12, sent: 1 });
    await render({
      api: chatApi(),
      teamApi: { sendTeamReview },
      client: EVENTS,
      runId: 'run-1',
      agentWorking: false,
    });

    await act(async () => {
      await seen!.send(null);
    });

    expect(sendTeamReview).toHaveBeenCalledTimes(1);
    expect(seen!.sending).toBe('waiting');
    expect(seen!.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_RETRY_MS);
    });

    expect(sendTeamReview).toHaveBeenCalledTimes(2);
    const ids = sendTeamReview.mock.calls.map(
      ([request]) =>
        (request as { sendReviewDto: { clientMessageId: string } })
          .sendReviewDto.clientMessageId,
    );
    expect(ids[1]).toBe(ids[0]);
    expect(seen!.sending).toBe('idle');
  });
});
