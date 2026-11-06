// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadMessageCard, ThreadOpenContext } from './thread-message-card';

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

const LONG_TEXT = `${'a'.repeat(1_500)}\nthe last line`;

const MESSAGES = [
  {
    id: 'm1',
    fromRunId: 'r-pelican',
    fromTitle: 'Pelican',
    fromMember: null,
    text: 'hi there',
  },
  {
    id: 'm2',
    fromRunId: 'r-otter',
    fromTitle: 'Otter',
    fromMember: 'Backend Engineer',
    text: LONG_TEXT,
  },
];

describe('ThreadMessageCard', () => {
  it('draws each message with its sender and its whole text', () => {
    const el = render(<ThreadMessageCard messages={MESSAGES} />);
    const cards = el.querySelectorAll('[data-slot="thread-message"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Pelican');
    expect(cards[0]?.textContent).toContain('hi there');
    expect(cards[1]?.textContent).toContain('Backend Engineer');
    expect(cards[1]?.textContent).toContain('the last line');
  });

  it('opens the sending thread when its title is pressed, where threads can open', () => {
    const opened: string[] = [];
    const el = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadMessageCard messages={MESSAGES} />
      </ThreadOpenContext.Provider>,
    );
    act(() => {
      el.querySelectorAll<HTMLButtonElement>(
        '[data-slot="thread-title"]',
      )[1]!.click();
    });
    expect(opened).toEqual(['r-otter']);
  });

  it('draws the title as plain text, not a control, where no thread can be opened', () => {
    const el = render(<ThreadMessageCard messages={MESSAGES} />);
    expect(el.querySelector('[data-slot="thread-title"]')).toBeNull();
    expect(el.textContent).toContain('Otter');
  });
});
