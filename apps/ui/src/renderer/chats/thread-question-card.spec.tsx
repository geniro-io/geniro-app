// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { RunStatusEvent } from '../daemon-client';
import { ApprovalCard } from './approval-card';
import { THREAD_QUESTION_CARD } from './geniro-tool';
import {
  deliverRelayedImages,
  readThreadQuestionRelay,
  RELAYED_IMAGES_SEND_ATTEMPTS,
  type ThreadQuestionRelay,
  threadQuestionRelayOfRow,
} from './thread-question-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RELAYED_PERMISSION = {
  threadRunId: 'thread-1',
  threadIsTeam: false,
  threadRequestId: 'req-1',
  handle: 't3',
  threadTitle: 'Billing cache',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
};

const RELAYED_QUESTION = {
  ...RELAYED_PERMISSION,
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    {
      question: 'Which cache should I clear?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'the shared one' },
        { label: 'Local', description: 'this machine only' },
      ],
      multiSelect: false,
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );

function renderCard(
  input: unknown,
  over: Partial<React.ComponentProps<typeof ApprovalCard>> = {},
): ReturnType<typeof vi.fn> {
  const onRespond = vi.fn();
  act(() =>
    root.render(
      <ApprovalCard
        toolName={THREAD_QUESTION_CARD}
        input={input}
        requestId="relay-1"
        verdict={null}
        onRespond={onRespond}
        {...over}
      />,
    ),
  );
  return onRespond;
}

describe('a thread question relayed into the manager chat', () => {
  it('reads the relayed request off the row, and refuses one with no handle', () => {
    expect(readThreadQuestionRelay(RELAYED_QUESTION)).toEqual({
      threadRunId: 'thread-1',
      threadIsTeam: false,
      handle: 't3',
      threadTitle: 'Billing cache',
      toolName: 'AskUserQuestion',
      input: {},
      questions: RELAYED_QUESTION.questions,
    });
    expect(
      readThreadQuestionRelay({ ...RELAYED_QUESTION, handle: '' }),
    ).toBeNull();
  });

  it('names the thread a row relays — where a picture sent with the answer goes — and no thread for any other row', () => {
    expect(
      threadQuestionRelayOfRow({
        id: 'relay-1',
        toolName: THREAD_QUESTION_CARD,
        input: { ...RELAYED_QUESTION, threadIsTeam: true },
      }),
    ).toMatchObject({ threadRunId: 'thread-1', threadIsTeam: true });
    expect(
      threadQuestionRelayOfRow({
        id: 'req-1',
        toolName: 'AskUserQuestion',
        input: RELAYED_QUESTION,
      }),
    ).toBeNull();
  });

  it('names the thread above the thread’s own question', () => {
    renderCard(RELAYED_QUESTION);
    expect(
      container.querySelector('[data-slot="thread-question-card"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      't3 · Billing cache is waiting on you',
    );
    expect(container.textContent).toContain('Which cache should I clear?');
  });

  it('answers through the card’s own verdict, as the thread’s card would', () => {
    const onRespond = renderCard(RELAYED_PERMISSION);
    expect(container.textContent).toContain('rm -rf build');
    act(() => button('Deny')!.click());
    expect(onRespond).toHaveBeenCalledWith(false);
  });

  it('says it is no longer open when it closed with no answer, with no buttons', () => {
    renderCard(RELAYED_QUESTION, { expired: true });
    expect(container.textContent).toContain(
      'No longer open — answered in the thread, or its turn ended.',
    );
    expect(container.textContent).not.toContain('Which cache should I clear?');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('says when an answer did not reach the thread', () => {
    renderCard(RELAYED_PERMISSION, {
      verdict: true,
      outcome: 'not-delivered',
    });
    expect(container.textContent).toContain(
      'Not delivered — the thread no longer waited on this.',
    );
  });

  it('draws an answerable permission card when the relay cannot be read', () => {
    const onRespond = renderCard({});
    expect(
      container.querySelector('[data-slot="thread-question-card"]'),
    ).toBeNull();
    act(() => button('Deny')!.click());
    expect(onRespond).toHaveBeenCalledWith(false);
  });

  it('says nothing more when the answer was delivered', () => {
    renderCard(RELAYED_PERMISSION, { verdict: true, outcome: 'delivered' });
    expect(container.textContent).not.toContain('Not delivered');
  });

  it('stops saying the thread waits once the card is answered or closed', () => {
    renderCard(RELAYED_QUESTION, { verdict: true, outcome: 'delivered' });
    expect(container.textContent).toContain('t3 · Billing cache asked');
    expect(container.textContent).not.toContain('is waiting on you');

    renderCard(RELAYED_QUESTION, { expired: true });
    expect(container.textContent).toContain('t3 · Billing cache asked');
    expect(container.textContent).not.toContain('is waiting on you');
  });
});

describe('deliverRelayedImages', () => {
  const IMAGES = [{ mediaType: 'image/png' as const, data: 'iVBO' }];
  const RELAY: ThreadQuestionRelay = {
    threadRunId: 'thread-1',
    threadIsTeam: false,
    handle: 't3',
    threadTitle: 'Billing cache',
    toolName: 'AskUserQuestion',
    input: {},
  };
  const busy = (): Error =>
    new Error(
      'daemon POST /v1/chats/thread-1/messages failed (409): ' +
        '{"statusCode":409,"code":"RUN_BUSY",' +
        '"message":"a turn is already in progress for this run",' +
        '"fullMessage":"[RUN_BUSY] a turn is already in progress for this run",' +
        '"fields":[]}',
    );

  function harness(): {
    apis: Pick<DaemonApis, 'chats' | 'teams'>;
    sendChatMessage: ReturnType<typeof vi.fn>;
    sendTeamRunMessage: ReturnType<typeof vi.fn>;
    announce: (event: Partial<RunStatusEvent>) => void;
    watchers: () => number;
    client: { onRunStatus: (l: (e: RunStatusEvent) => void) => () => void };
  } {
    const listeners = new Set<(event: RunStatusEvent) => void>();
    const sendChatMessage = vi.fn();
    const sendTeamRunMessage = vi.fn();
    return {
      apis: {
        chats: { sendChatMessage },
        teams: { sendTeamRunMessage },
      } as unknown as Pick<DaemonApis, 'chats' | 'teams'>,
      sendChatMessage,
      sendTeamRunMessage,
      announce: (event) => {
        for (const listener of [...listeners]) {
          listener({ runId: 'thread-1', status: null, ...event });
        }
      },
      watchers: () => listeners.size,
      client: {
        onRunStatus: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
  }

  const flush = (): Promise<void> =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it('sends the pictures to the thread once its answer turn settles when that turn refused them', async () => {
    const h = harness();
    h.sendChatMessage.mockRejectedValueOnce(busy()).mockResolvedValueOnce({});
    const onError = vi.fn();

    deliverRelayedImages(RELAY, IMAGES, h.apis, h.client, onError);
    await flush();
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);

    h.announce({ status: 'running' });
    h.announce({ runId: 'other-run', status: 'completed' });
    h.announce({ status: 'cancelled' });
    await flush();
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);

    h.announce({ status: 'completed' });
    await flush();
    expect(h.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(h.sendChatMessage).toHaveBeenLastCalledWith({
      runId: 'thread-1',
      sendMessageDto: { text: '', images: IMAGES },
    });
    expect(h.watchers()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("sends a team thread's pictures through the team route", async () => {
    const h = harness();
    h.sendTeamRunMessage.mockResolvedValueOnce({});

    deliverRelayedImages(
      { ...RELAY, threadIsTeam: true },
      IMAGES,
      h.apis,
      h.client,
      vi.fn(),
    );
    await flush();

    expect(h.sendTeamRunMessage).toHaveBeenCalledWith({
      runId: 'thread-1',
      sendMessageDto: { text: '', images: IMAGES },
    });
    expect(h.sendChatMessage).not.toHaveBeenCalled();
  });

  it('reports any other refusal at once and waits for nothing', async () => {
    const h = harness();
    const refusal = new Error(
      'daemon POST /v1/chats/thread-1/messages failed (404): gone',
    );
    h.sendChatMessage.mockRejectedValueOnce(refusal);
    const onError = vi.fn();

    deliverRelayedImages(RELAY, IMAGES, h.apis, h.client, onError);
    await flush();

    expect(onError).toHaveBeenCalledWith(refusal);
    expect(h.watchers()).toBe(0);
  });

  it('gives up and reports after its last attempt is refused', async () => {
    const h = harness();
    h.sendChatMessage.mockRejectedValue(busy());
    const onError = vi.fn();

    deliverRelayedImages(RELAY, IMAGES, h.apis, h.client, onError);
    await flush();
    for (let settle = 1; settle < RELAYED_IMAGES_SEND_ATTEMPTS; settle++) {
      h.announce({ status: 'completed' });
      await flush();
    }

    expect(h.sendChatMessage).toHaveBeenCalledTimes(
      RELAYED_IMAGES_SEND_ATTEMPTS,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.watchers()).toBe(0);
  });
});
