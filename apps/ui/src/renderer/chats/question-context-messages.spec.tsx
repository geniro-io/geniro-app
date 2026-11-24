// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionContextMessages } from './question-context-messages';
import {
  type ThreadContextMessage,
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGES: ThreadContextMessage[] = [
  { seq: 4, role: 'user', text: 'Clear the cache' },
  { seq: 5, role: 'assistant', text: 'Two caches could be meant' },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(reader: ThreadContextReader | null, requestId = 'req-1'): void {
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

const settle = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

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

  it('draws nothing where no reader is provided', () => {
    draw(null);

    expect(container.childElementCount).toBe(0);
  });
});
