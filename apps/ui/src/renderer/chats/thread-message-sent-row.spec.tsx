// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadOpenContext } from './thread-message-card';
import type { ThreadMessageSent } from './thread-message-payload';
import { ThreadMessageSentRow } from './thread-message-sent-row';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const sent = (
  outcome: ThreadMessageSent['outcome'],
  reason: ThreadMessageSent['reason'],
): ThreadMessageSent => ({
  toRunId: 'r-otter',
  title: 'Otter',
  outcome,
  reason,
});

describe('ThreadMessageSentRow', () => {
  it.each<[ThreadMessageSent['outcome'], ThreadMessageSent['reason'], string]>([
    ['joined', null, 'Message to Otter joined the running turn'],
    ['woken', null, 'Message to Otter started a turn there'],
    [
      'waiting',
      'stopped',
      'Message to Otter waits, because the user stopped that thread',
    ],
    ['waiting', null, 'Message to Otter is waiting'],
  ])(
    'says what became of a %s send with reason %s',
    (outcome, reason, words) => {
      const el = render(<ThreadMessageSentRow sent={sent(outcome, reason)} />);
      const row = el.querySelector('[data-slot="thread-message-sent"]');
      expect(row?.textContent).toContain(words);
      expect(row?.getAttribute('data-outcome')).toBe(outcome);
    },
  );

  it('opens the thread the message went to when that title is pressed', () => {
    const opened: string[] = [];
    const el = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadMessageSentRow sent={sent('joined', null)} />
      </ThreadOpenContext.Provider>,
    );
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-title"]',
      )!.click();
    });
    expect(opened).toEqual(['r-otter']);
  });
});
