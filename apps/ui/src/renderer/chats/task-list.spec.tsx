// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunSettledContext } from './live-row';
import { TaskListCard, TaskRows } from './task-list';
import type { AgentTaskRow } from './task-payload';
import type { TaskListEntry } from './transcript-groups';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(el: React.ReactNode): void {
  act(() => root.render(el));
}

const rows: AgentTaskRow[] = [
  { id: '1', title: 'Read the file', status: 'completed', activeForm: null },
  {
    id: '2',
    title: 'Edit the file',
    status: 'in_progress',
    activeForm: 'Editing the file',
  },
  { id: '3', title: 'Run the tests', status: 'pending', activeForm: null },
];

function card(overrides: Partial<TaskListEntry> = {}): TaskListEntry {
  return {
    type: 'task-list',
    id: 'c1',
    createdAt: '2026-08-14T10:00:00.000Z',
    seq: 5,
    nodeId: null,
    parentToolUseId: null,
    tasks: rows,
    latest: true,
    ...overrides,
  };
}

/** Every task line on screen, in order. */
function taskTexts(): string[] {
  return [...container.querySelectorAll('li')].map(
    (row) => row.textContent ?? '',
  );
}

/**
 * Whether anything on screen is actually SPINNING.
 *
 * The animation class, which is what makes the glyph move — not a marker the
 * test invented, and not "is the icon a Loader2", which would pass on a static
 * copy of it.
 */
function spinning(): boolean {
  return container.querySelector('.animate-spin') !== null;
}

describe('TaskListCard', () => {
  it('lists every task and says how far along the list is', () => {
    render(<TaskListCard entry={card()} />);
    expect(taskTexts()).toEqual([
      'Read the file',
      // The present-continuous label for the one being worked on — what the
      // CLI's own UI shows there, and the reason the daemon carries the field.
      'Editing the file',
      'Run the tests',
    ]);
    expect(container.textContent).toContain('1/3');
  });

  it('names a task by its id when no announcement carried its text', () => {
    // Reachable: a claude `TaskUpdate` patch can be the FIRST thing seen for a
    // task, and it sends `{taskId, status}` alone. An empty row would be worse.
    render(
      <TaskListCard
        entry={card({
          tasks: [
            { id: '9', title: null, status: 'pending', activeForm: null },
          ],
        })}
      />,
    );
    expect(taskTexts()).toEqual(['Task 9']);
  });

  it('renders nothing at all for an empty list', () => {
    render(<TaskListCard entry={card({ tasks: [] })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('a task list nothing is working through', () => {
  it('stops the in-progress row spinning once the run has settled', () => {
    // The reported defect: "somewhere it finished one task, still in progress
    // for some reason" — a chat whose turn ended with a task mid-flight kept a
    // spinner on it for good. The row is still distinguishable from pending; it
    // just stops claiming that work is happening.
    render(
      <RunSettledContext.Provider value={Date.parse('2026-08-14T11:00:00Z')}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(false);
    // And it says "Edit the file", not "Editing the file": the active form is a
    // claim about work under way.
    expect(taskTexts()).toContain('Edit the file');
    // Stated on the element too, because the verdict is not otherwise visible
    // from outside: the rule reads a context value and the card's own place in
    // its thread, so this is the only handle a test or an inspector has on it.
    expect(
      container
        .querySelector('[data-slot="task-list-card"]')
        ?.getAttribute('data-live'),
    ).toBe('false');
  });

  it('keeps spinning while the run is live', () => {
    render(
      <RunSettledContext.Provider value={null}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(true);
  });

  it('stops an EARLIER card spinning even on a live run', () => {
    // A historical snapshot: the list has moved on since. Three cards each
    // animating their own in-progress task is three spinners for one task, none
    // of them still true.
    render(
      <RunSettledContext.Provider value={null}>
        <TaskListCard entry={card({ latest: false })} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(false);
  });

  it('keeps spinning for a card written AFTER the run settled', () => {
    // The off-turn case: the CLI carries on by itself past its own turn-end
    // line, so a card newer than the settle is live work whatever the row says.
    render(
      <RunSettledContext.Provider value={Date.parse('2026-08-14T09:00:00Z')}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(true);
  });
});

describe('TaskRows', () => {
  it('renders a live list with motion and a dead one without', () => {
    // The shared renderer both surfaces use, so the side panel and the
    // transcript cannot disagree about what a running task looks like.
    render(<TaskRows tasks={rows} live />);
    expect(spinning()).toBe(true);
    render(<TaskRows tasks={rows} live={false} />);
    expect(spinning()).toBe(false);
  });
});
