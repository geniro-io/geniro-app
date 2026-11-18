// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';
import { THREAD_QUESTION_CARD } from './geniro-tool';
import {
  readThreadQuestionRelay,
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
});
