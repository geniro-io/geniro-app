// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STUB_PICTURE_DATA_URL,
  stubThreadContextReader,
} from '../__fixtures__/thread-context-reader';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { LocalImageLoaderContext } from './local-image-loader';
import type { QuestionAttachmentSet } from './question-attachments-payload';
import { QuestionContextMessages } from './question-context-messages';
import {
  type ThreadContextMessage,
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';
import { ThreadUiMemoryContext } from './thread-ui-memory';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const MESSAGES: ThreadContextMessage[] = [
  { seq: 4, role: 'user', text: 'Clear the cache' },
  { seq: 5, role: 'assistant', text: 'Two caches could be meant' },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function drawWith(
  reader: ThreadContextReader | null,
  requestId = 'req-1',
): void {
  act(() => {
    root.render(
      <ThreadContextReaderContext.Provider value={reader}>
        <QuestionContextMessages
          threadRunId="thread-1"
          threadRequestId={requestId}
        />
      </ThreadContextReaderContext.Provider>,
    );
  });
}

function draw(
  read: ThreadContextReader['read'] | null,
  requestId = 'req-1',
): void {
  drawWith(read === null ? null : stubThreadContextReader(read), requestId);
}

const FIVE_LINES = (name: string): string =>
  [1, 2, 3, 4, 5].map((line) => `${name}, line ${line}.`).join('\n');

const LONG_MESSAGES: ThreadContextMessage[] = [
  { seq: 1, role: 'user', text: FIVE_LINES('Clear the shared cache') },
  { seq: 2, role: 'assistant', text: FIVE_LINES('Two caches could be meant') },
  { seq: 3, role: 'user', text: FIVE_LINES('The shared one') },
];

function drawInThread(
  read: ThreadContextReader['read'],
  requestId: string,
): void {
  act(() => {
    root.render(
      <ThreadUiMemoryContext.Provider value="manager-run">
        <ThreadContextReaderContext.Provider
          value={stubThreadContextReader(read)}>
          <QuestionContextMessages
            threadRunId="thread-1"
            threadRequestId={requestId}
          />
        </ThreadContextReaderContext.Provider>
      </ThreadUiMemoryContext.Provider>,
    );
  });
}

const messagesBlock = (): HTMLElement | null =>
  container.querySelector<HTMLElement>(
    '[data-slot="thread-question-context-messages"]',
  );

const messagesToggle = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(
    '[data-slot="thread-question-context-messages-toggle"]',
  )!;

const settle = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await settle();
  }
};

const toggle = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(
    '[data-slot="thread-question-show-context"]',
  )!;

const context = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="thread-question-context"]');

describe('QuestionContextMessages', () => {
  it('reads the messages before the question and draws them expanded, without a press', async () => {
    const reader = vi.fn().mockResolvedValue(MESSAGES);
    draw(reader);

    expect(reader).toHaveBeenCalledWith('thread-1', 'req-1');
    expect(context()?.dataset.state).toBe('loading');
    await settle();

    expect(context()?.dataset.state).toBe('shown');
    expect(
      [
        ...container.querySelectorAll<HTMLElement>(
          '[data-slot="thread-question-context-message"]',
        ),
      ].map((message) => message.dataset.role),
    ).toEqual(['user', 'assistant']);
    expect(toggle().textContent).toBe('Hide messages');
  });

  it('folds the messages on Hide messages, and reads them again on Show a few messages', async () => {
    const reader = vi.fn().mockResolvedValue(MESSAGES);
    draw(reader);
    await settle();

    act(() => toggle().click());
    expect(context()).toBeNull();
    expect(toggle().textContent).toBe('Show a few messages');

    act(() => toggle().click());
    expect(reader).toHaveBeenCalledTimes(2);
    await settle();
    expect(context()?.dataset.state).toBe('shown');
  });

  it('reads the messages of the question it is given', async () => {
    const reader = vi.fn().mockResolvedValue(MESSAGES);
    draw(reader, 'req-1');
    draw(reader, 'req-2');

    expect(reader).toHaveBeenLastCalledWith('thread-1', 'req-2');
  });

  it('says the thread said nothing when no message came before the question', async () => {
    draw(vi.fn().mockResolvedValue([]));
    await settle();

    expect(context()?.textContent).toContain(
      'The thread said nothing before this question.',
    );
  });

  it('says so when the messages cannot be read', async () => {
    draw(() => Promise.reject(new Error('daemon down')));
    await settle();

    expect(context()?.dataset.state).toBe('failed');
  });

  it('draws one Show more for the whole list of messages, and none on a message inside it', async () => {
    draw(vi.fn().mockResolvedValue(LONG_MESSAGES));
    await settle();

    expect(messagesBlock()?.dataset.clamped).toBe('true');
    expect(messagesToggle().textContent).toContain('Show more');
    expect(
      messagesBlock()!.querySelectorAll('[data-slot$="-toggle"]'),
    ).toHaveLength(1);
  });

  it('unfolds every message at once on Show more, and folds the list again on Show less', async () => {
    draw(vi.fn().mockResolvedValue(LONG_MESSAGES));
    await settle();

    act(() => messagesToggle().click());
    expect(messagesBlock()!.dataset.clamped).toBeUndefined();
    expect(container.querySelector('[data-clamped]')).toBeNull();
    expect(
      (messagesBlock()!.firstElementChild as HTMLElement).style.maxHeight,
    ).toBe('');
    expect(messagesToggle().textContent).toContain('Show less');

    act(() => messagesToggle().click());
    expect(messagesBlock()!.dataset.clamped).toBe('true');
    expect(
      (messagesBlock()!.firstElementChild as HTMLElement).style.maxHeight,
    ).toBe('14.4em');
    expect(messagesToggle().textContent).toContain('Show more');
  });

  it('draws no toggle and no clamp when the messages together are short', async () => {
    draw(vi.fn().mockResolvedValue(MESSAGES));
    await settle();

    expect(messagesBlock()).not.toBeNull();
    expect(messagesBlock()!.dataset.clamped).toBeUndefined();
    expect(messagesBlock()!.querySelector('[data-slot$="-toggle"]')).toBeNull();
  });

  it('remembers an expanded list within the thread across a remount, and per question', async () => {
    const reader = vi.fn().mockResolvedValue(LONG_MESSAGES);
    drawInThread(reader, 'req-1');
    await settle();
    act(() => messagesToggle().click());

    act(() => root.render(null));
    drawInThread(reader, 'req-1');
    await settle();
    expect(messagesBlock()!.dataset.clamped).toBeUndefined();
    expect(messagesToggle().textContent).toContain('Show less');

    act(() => root.render(null));
    drawInThread(reader, 'req-2');
    await settle();
    expect(messagesBlock()!.dataset.clamped).toBe('true');
  });

  it('draws nothing where no reader is provided', () => {
    draw(null);

    expect(container.childElementCount).toBe(0);
  });
});

describe('QuestionContextMessages binds a picture its messages name to the thread’s run', () => {
  it('loads a picture a message of the thread names through the thread’s run, not the run drawing the question', async () => {
    const threadLoader = vi.fn().mockResolvedValue(STUB_PICTURE_DATA_URL);
    const loaderFor = vi.fn(() => threadLoader);
    const outerLoader = vi.fn().mockResolvedValue(STUB_PICTURE_DATA_URL);
    act(() => {
      root.render(
        <LocalImageLoaderContext.Provider value={outerLoader}>
          <ThreadContextReaderContext.Provider
            value={stubThreadContextReader(
              () =>
                Promise.resolve([
                  {
                    seq: 2,
                    role: 'assistant',
                    text: 'The strip now ![shot](/tmp/shot.png)',
                  },
                ]),
              { loadImage: loaderFor },
            )}>
            <QuestionContextMessages
              threadRunId="thread-1"
              threadRequestId="req-1"
            />
          </ThreadContextReaderContext.Provider>
        </LocalImageLoaderContext.Provider>,
      );
    });
    await flush();

    expect(loaderFor).toHaveBeenCalledWith('thread-1');
    expect(threadLoader).toHaveBeenCalledWith('/tmp/shot.png');
    expect(outerLoader).not.toHaveBeenCalled();
  });
});

describe('a question row that carries its attachments', () => {
  const PLAN = {
    artifactId: 'plan',
    version: 1,
    title: 'Plan',
    summary: null,
    key: 'a'.repeat(64),
  };
  const OTHER = { ...PLAN, artifactId: 'other', title: 'Other page' };

  function drawAttached(
    read: ThreadContextReader['read'],
    attachments: QuestionAttachmentSet | undefined,
  ): void {
    act(() => {
      root.render(
        <ThreadContextReaderContext.Provider
          value={stubThreadContextReader(read, {
            artifacts: () => Promise.resolve([PLAN, OTHER]),
          })}>
          <QuestionContextMessages
            threadRunId="thread-1"
            threadRequestId="req-1"
            attachments={attachments}
          />
        </ThreadContextReaderContext.Provider>,
      );
    });
  }

  it('draws exactly the attached pages, and no other page the thread holds', async () => {
    drawAttached(vi.fn().mockResolvedValue(MESSAGES), {
      attachments: [
        { kind: 'artifact', artifactId: 'plan', title: 'Plan', version: 1 },
      ],
    });
    await settle();

    const pages = container.querySelectorAll('[data-slot="artifact-card"]');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.textContent).toContain('Plan');
    expect(container.textContent).not.toContain('Other page');
  });

  it('draws no page for a question written before attachments, though its thread holds one', async () => {
    drawAttached(vi.fn().mockResolvedValue(MESSAGES), undefined);
    await settle();

    expect(container.querySelector('[data-slot="artifact-card"]')).toBeNull();
    expect(container.textContent).not.toContain('Plan');
  });
});
