// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskListCard, TaskStrip } from './task-list';
import type { AgentTaskRow } from './task-payload';

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

/** Every task line on screen, in order. */
function taskTexts(): string[] {
  return [...container.querySelectorAll('li')].map(
    (row) => row.textContent ?? '',
  );
}

describe('TaskListCard', () => {
  it('lists every task and says how far along the list is', () => {
    render(<TaskListCard tasks={rows} />);
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
        tasks={[{ id: '9', title: null, status: 'pending', activeForm: null }]}
      />,
    );
    expect(taskTexts()).toEqual(['Task 9']);
  });

  it('renders nothing at all for an empty list', () => {
    render(<TaskListCard tasks={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('TaskStrip', () => {
  it('states the count and the current task without being opened', () => {
    // The whole point of the strip: the transcript cards scroll away, so the
    // current state has to be legible in the one line it costs.
    render(<TaskStrip tasks={rows} />);
    expect(container.textContent).toContain('1/3');
    expect(container.textContent).toContain('Editing the file');
    expect(taskTexts()).toEqual([]);
  });

  it('opens onto the whole list', () => {
    render(<TaskStrip tasks={rows} />);
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(taskTexts()).toEqual([
      'Read the file',
      'Editing the file',
      'Run the tests',
    ]);
  });

  it('renders nothing when the agent kept no list', () => {
    render(<TaskStrip tasks={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
