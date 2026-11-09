// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import { ThreadOpenContext } from './thread-message-card';
import { ThreadWakeDivider } from './thread-wake-divider';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

describe('ThreadWakeDivider', () => {
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
});
