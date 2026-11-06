// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadOpenContext } from './thread-message-card';
import { ThreadWakeDivider } from './thread-wake-divider';

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

describe('ThreadWakeDivider', () => {
  it('says who picked back up, and which thread’s message woke the turn', () => {
    const el = render(
      <ThreadWakeDivider
        caller="Manager"
        fromRunId="r-pelican"
        fromTitle="Pelican"
      />,
    );
    expect(
      el.querySelector('[data-slot="thread-wake-divider"]')?.textContent,
    ).toContain('Manager picked back up — a message from Pelican');
  });

  it('names an agent with no name as “The agent”', () => {
    const el = render(
      <ThreadWakeDivider
        caller={null}
        fromRunId="r-pelican"
        fromTitle="Pelican"
      />,
    );
    expect(el.textContent).toContain('The agent picked back up');
  });

  it('opens the thread whose message woke the turn when it is pressed', () => {
    const opened: string[] = [];
    const el = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadWakeDivider
          caller="Manager"
          fromRunId="r-pelican"
          fromTitle="Pelican"
        />
      </ThreadOpenContext.Provider>,
    );
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-title"]',
      )!.click();
    });
    expect(opened).toEqual(['r-pelican']);
  });

  it('draws the thread as plain text, not a dead control, where none can be opened', () => {
    const el = render(
      <ThreadWakeDivider
        caller="Manager"
        fromRunId="r-pelican"
        fromTitle="Pelican"
      />,
    );
    expect(el.querySelector('[data-slot="thread-title"]')).toBeNull();
    expect(el.textContent).toContain('a message from Pelican');
  });
});
