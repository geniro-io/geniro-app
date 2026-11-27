// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubThreadContextReader } from '../__fixtures__/thread-context-reader';
import {
  bareThreadIdentity,
  type ThreadIdentity,
} from '../components/thread-head';
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
import { ThreadContextReaderContext } from './thread-question-context';
import { ThreadIdentityContext, ThreadOpenContext } from './thread-title';
import { ThreadUiMemoryContext } from './thread-ui-memory';

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

const slotText = (name: string): string | null | undefined =>
  container.querySelector(`[data-slot="${name}"]`)?.textContent;

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
      threadRequestId: 'req-1',
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

  it('spans the transcript column rather than stopping short of it', () => {
    renderCard(RELAYED_QUESTION);
    const card = container.querySelector<HTMLElement>(
      '[data-slot="thread-question-card"]',
    )!;
    expect(card.classList).toContain('w-full');
    expect(card.className).not.toMatch(/\bmax-w-|\bself-start\b/);
  });

  it('offers Open chat where the view can open the thread, and shows the messages before the question expanded at once', async () => {
    const opened: string[] = [];
    const reader = vi.fn().mockResolvedValue([
      { seq: 4, role: 'user', text: 'Clear the cache' },
      { seq: 5, role: 'assistant', text: 'Two caches could be meant' },
    ]);
    act(() =>
      root.render(
        <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
          <ThreadContextReaderContext.Provider
            value={stubThreadContextReader(reader)}>
            <ApprovalCard
              toolName={THREAD_QUESTION_CARD}
              input={RELAYED_QUESTION}
              requestId="relay-1"
              verdict={null}
              onRespond={vi.fn()}
            />
          </ThreadContextReaderContext.Provider>
        </ThreadOpenContext.Provider>,
      ),
    );
    const actions = container.querySelector(
      '[data-slot="thread-question-actions"]',
    )!;
    const head = container.querySelector('[data-slot="thread-question-head"]')!;
    expect(
      actions.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-question-open-chat"]',
        )!
        .click(),
    );
    expect(opened).toEqual(['thread-1']);

    expect(reader).toHaveBeenCalledWith('thread-1', 'req-1');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-slot="thread-question-show-context"]',
      )!.textContent,
    ).toBe('Hide messages');
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="thread-question-context"]',
      )?.dataset.state,
    ).toBe('loading');

    await act(async () => {
      await Promise.resolve();
    });
    const shown = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-slot="thread-question-context-message"]',
      ),
    ];
    expect(shown.map((message) => message.dataset.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(shown[1]!.textContent).toContain('Two caches could be meant');
    expect(
      head.compareDocumentPosition(shown[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain('Which cache should I clear?');
  });

  it('folds the messages on Hide messages, and reads them again on Show a few messages', async () => {
    const reader = vi
      .fn()
      .mockResolvedValue([
        { seq: 5, role: 'assistant', text: 'Two caches could be meant' },
      ]);
    act(() =>
      root.render(
        <ThreadContextReaderContext.Provider
          value={stubThreadContextReader(reader)}>
          <ApprovalCard
            toolName={THREAD_QUESTION_CARD}
            input={RELAYED_QUESTION}
            requestId="relay-1"
            verdict={null}
            onRespond={vi.fn()}
          />
        </ThreadContextReaderContext.Provider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const toggle = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(
        '[data-slot="thread-question-show-context"]',
      )!;

    act(() => toggle().click());
    expect(
      container.querySelector('[data-slot="thread-question-context"]'),
    ).toBeNull();
    expect(toggle().textContent).toBe('Show a few messages');

    act(() => toggle().click());
    expect(reader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="thread-question-context"]',
      )?.dataset.state,
    ).toBe('shown');
    expect(toggle().textContent).toBe('Hide messages');
  });

  it('says so when the thread’s messages cannot be read', async () => {
    act(() =>
      root.render(
        <ThreadContextReaderContext.Provider
          value={stubThreadContextReader(() =>
            Promise.reject(new Error('daemon down')),
          )}>
          <ApprovalCard
            toolName={THREAD_QUESTION_CARD}
            input={RELAYED_QUESTION}
            requestId="relay-1"
            verdict={null}
            onRespond={vi.fn()}
          />
        </ThreadContextReaderContext.Provider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="thread-question-context"]',
      )?.dataset.state,
    ).toBe('failed');
  });

  it('draws no Open chat and no messages where the view can neither open the thread nor read it', () => {
    renderCard(RELAYED_QUESTION);
    expect(
      container.querySelector('[data-slot="thread-question-actions"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="thread-question-show-context"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="thread-question-context"]'),
    ).toBeNull();
  });

  it('heads the thread’s own question with the thread, and says it waits on the user', () => {
    renderCard(RELAYED_QUESTION);
    const card = container.querySelector<HTMLElement>(
      '[data-slot="thread-question-card"]',
    )!;
    expect(card.dataset.state).toBe('waiting');
    expect(slotText('thread-question-label')).toBe('Question for you');
    expect(slotText('thread-question-handle')).toBe('t3');
    expect(slotText('thread-question-title')).toBe('Billing cache');
    expect(slotText('thread-question-waiting')).toBe('Waiting on you');
    expect(container.textContent).toContain('Which cache should I clear?');
  });

  it('heads it as the thread’s node on the graph does where the view knows the thread', () => {
    const opened: string[] = [];
    act(() =>
      root.render(
        <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
          <ThreadIdentityContext.Provider
            value={
              new Map([
                [
                  'thread-1',
                  {
                    ...bareThreadIdentity('Billing cache — clear the layer'),
                    face: { kind: 'agent', icon: 'terminal', name: 'claude' },
                    status: { attention: 'question', text: 'Question for you' },
                    agentLabel: 'claude',
                    project: 'Web',
                    projectColor: 'teal',
                  } satisfies ThreadIdentity,
                ],
              ])
            }>
            <ApprovalCard
              toolName={THREAD_QUESTION_CARD}
              input={RELAYED_QUESTION}
              requestId="relay-1"
              verdict={null}
              onRespond={vi.fn()}
            />
          </ThreadIdentityContext.Provider>
        </ThreadOpenContext.Provider>,
      ),
    );
    expect(slotText('thread-question-title')).toBe(
      'Billing cache — clear the layer',
    );
    expect(
      container.querySelector<HTMLElement>('[data-slot="thread-question-face"]')
        ?.dataset.face,
    ).toBe('agent');
    expect(slotText('thread-question-status')).toBe('Question for you');
    expect(slotText('thread-question-project')).toBe('Web');
    expect(
      container.querySelector('[data-slot="thread-question-card"]')!.className,
    ).not.toContain('border-warning');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-question-title"]',
        )!
        .click(),
    );
    expect(opened).toEqual(['thread-1']);
  });

  it('draws the question a relay carries only in its input as a question, never as raw JSON', () => {
    renderCard({
      ...RELAYED_PERMISSION,
      toolName: 'ask_user_question',
      input: {
        title: 'Which source?',
        questions: RELAYED_QUESTION.questions,
      },
    });
    expect(
      container.querySelector('[data-slot="question-card"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Which cache should I clear?');
    expect(container.textContent).not.toContain('"questions"');
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

  it('stops saying the thread waits once the card is answered, declined or closed', () => {
    renderCard(RELAYED_PERMISSION, { verdict: true, outcome: 'delivered' });
    expect(slotText('thread-question-label')).toBe('Answered');
    expect(
      container.querySelector('[data-slot="thread-question-waiting"]'),
    ).toBeNull();

    renderCard(RELAYED_PERMISSION, { verdict: false });
    expect(slotText('thread-question-label')).toBe('Declined');

    renderCard(RELAYED_QUESTION, { expired: true });
    expect(slotText('thread-question-label')).toBe('No longer open');
    expect(
      container.querySelector('[data-slot="thread-question-waiting"]'),
    ).toBeNull();
  });
});

describe('a relayed question once settled', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  const card = (): HTMLElement =>
    container.querySelector<HTMLElement>('[data-slot="thread-question-card"]')!;
  const toggle = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(
      '[data-slot="question-card-toggle"]',
    )!;
  const press = (): void => act(() => toggle().click());

  function renderOpenable(
    over: Partial<React.ComponentProps<typeof ApprovalCard>>,
    input: unknown = RELAYED_QUESTION,
  ): void {
    act(() =>
      root.render(
        <ThreadOpenContext.Provider value={() => undefined}>
          <ApprovalCard
            toolName={THREAD_QUESTION_CARD}
            input={input}
            requestId="relay-1"
            verdict={null}
            onRespond={vi.fn()}
            {...over}
          />
        </ThreadOpenContext.Provider>,
      ),
    );
  }

  it('folds an answered one into its question card alone, naming the thread, the question and the answer', () => {
    renderOpenable({ verdict: true, answer: 'Redis' });
    expect(card().dataset.folded).toBe('true');
    expect(card().dataset.state).toBe('answered');
    expect(slotText('question-card-title')).toBe('Question from Billing cache');
    expect(slotText('question-card-question')).toBe(
      'Which cache should I clear?',
    );
    expect(slotText('question-card-summary')).toBe('✓ answered · Redis');
    expect(
      container.querySelector('[data-slot="thread-question-label"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="thread-question-head"]'),
    ).toBeNull();
    expect(button('Open chat')).toBeUndefined();
    expect(
      container.querySelectorAll('[data-slot="question-card-toggle"]'),
    ).toHaveLength(1);
  });

  it('draws the pages a folded answered card was asked about as chips under it, and none for a relay written before attachments', async () => {
    const reader = stubThreadContextReader(() => Promise.resolve([]), {
      artifacts: () =>
        Promise.resolve([
          {
            artifactId: 'plan',
            version: 1,
            title: 'Plan',
            summary: null,
            key: 'k',
          },
        ]),
    });
    const draw = (input: unknown) =>
      act(() => {
        root.render(
          <ThreadContextReaderContext.Provider value={reader}>
            <ThreadOpenContext.Provider value={() => undefined}>
              <ApprovalCard
                toolName={THREAD_QUESTION_CARD}
                input={input}
                requestId="relay-1"
                verdict={true}
                answer="Redis"
                onRespond={vi.fn()}
              />
            </ThreadOpenContext.Provider>
          </ThreadContextReaderContext.Provider>,
        );
      });
    const attached = {
      attachments: [
        { kind: 'artifact', artifactId: 'plan', title: 'Plan', version: 1 },
      ],
      moreAttachments: 0,
    };
    draw({ ...RELAYED_QUESTION, ...attached });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(card().dataset.folded).toBe('true');
    const chips = card().querySelectorAll(
      '[data-slot="question-attachment-chip"]',
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute('aria-label')).toBe('Plan');
    expect(card().querySelector('iframe')).toBeNull();

    draw(RELAYED_QUESTION);
    expect(
      card().querySelectorAll('[data-slot="question-attachment-chip"]'),
    ).toHaveLength(0);
  });

  it('opens the whole card with one press and folds it back with the next', () => {
    renderOpenable({ verdict: true, answer: 'Redis' });
    press();
    expect(card().dataset.folded).toBeUndefined();
    expect(slotText('thread-question-label')).toBe('Answered');
    expect(slotText('thread-question-title')).toBe('Billing cache');
    expect(button('Open chat')).toBeDefined();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(slotText('question-card-title')).toBe('Agent asks a question');

    press();
    expect(card().dataset.folded).toBe('true');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(button('Open chat')).toBeUndefined();
  });

  it('folds a declined one the same way', () => {
    renderOpenable({ verdict: false });
    expect(card().dataset.folded).toBe('true');
    expect(slotText('question-card-summary')).toBe('✗ declined');
  });

  it('still says when the answer did not reach the thread while folded', () => {
    renderOpenable({
      verdict: true,
      answer: 'Redis',
      outcome: 'not-delivered',
    });
    expect(card().dataset.folded).toBe('true');
    expect(container.textContent).toContain(
      'Not delivered — the thread no longer waited on this.',
    );
  });

  it('leaves a pending one open with the thread around it, and folds all of it on a press', () => {
    renderOpenable({});
    expect(card().dataset.folded).toBeUndefined();
    expect(slotText('thread-question-waiting')).toBe('Waiting on you');
    expect(button('Open chat')).toBeDefined();
    expect(slotText('question-card-title')).toBe('Agent asks a question');

    press();
    expect(card().dataset.folded).toBe('true');
    expect(button('Open chat')).toBeUndefined();
  });

  it('leaves one closed with no answer open, as an expired question card is', () => {
    renderOpenable({ expired: true });
    expect(card().dataset.folded).toBeUndefined();
    expect(slotText('thread-question-title')).toBe('Billing cache');
    expect(container.textContent).toContain('No longer open');
  });

  it('never folds a relayed permission', () => {
    renderOpenable({ verdict: true }, RELAYED_PERMISSION);
    expect(card().dataset.folded).toBeUndefined();
    expect(slotText('thread-question-label')).toBe('Answered');
    expect(container.textContent).toContain('rm -rf build');
  });

  it('remembers the press in the manager chat across a remount, as a thread chat does', () => {
    const view = (
      <ThreadUiMemoryContext.Provider value="manager-run">
        <ApprovalCard
          toolName={THREAD_QUESTION_CARD}
          input={RELAYED_QUESTION}
          requestId="relay-remembered"
          verdict={true}
          answer="Redis"
          onRespond={vi.fn()}
        />
      </ThreadUiMemoryContext.Provider>
    );
    act(() => root.render(view));
    press();
    expect(card().dataset.folded).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(view));
    expect(card().dataset.folded).toBeUndefined();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
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
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
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
