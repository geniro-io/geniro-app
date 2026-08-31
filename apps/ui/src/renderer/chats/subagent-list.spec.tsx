// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentThread } from './agent-activity';
import { SubagentRows } from './subagent-list';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every root this test mounted, so a test that renders TWICE — the one pinning
 * that the fold is remembered across a remount — still leaves nothing behind.
 */
const mounted: { container: HTMLElement; root: Root }[] = [];

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted.push({ container, root });
  return container;
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  // The fold is persisted, so a test that opens it would otherwise decide the
  // starting state of every test after it.
  localStorage.clear();
});

const thread = (over: Partial<AgentThread> = {}): AgentThread => ({
  id: 't1',
  kind: 'subagent',
  label: 'explore',
  status: 'running',
  sessionId: null,
  ...over,
});

/** The labels in the order they were drawn. */
function labels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-slot="subagent-row"]')].map(
    (row) => row.firstElementChild!.nextElementSibling!.textContent ?? '',
  );
}

/** The control counting the finished delegates, or null where there is none. */
function fold(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('button[aria-expanded]');
}

function click(button: HTMLElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('SubagentRows', () => {
  it('says so in words when there are no delegates to list', () => {
    // A panel with nothing in it reads as a readout that failed to load. The
    // shelf chip that draws this never appears empty, but the sentence belongs
    // to the component so the next surface to hang it off a count that IS drawn
    // at zero gets it for free.
    const el = render(<SubagentRows threads={[]} />);
    expect(el.textContent).toContain('No sub-agents yet');
  });

  it('lists only what is still working, and COUNTS the rest behind a fold', () => {
    // REPORTED as "completed subagents should be collapsed", over a popover
    // holding six running and four finished. This list used to SORT the running
    // ones to the top instead, on the reasoning that a popover cannot fold —
    // which left every row past the sixth on screen, scrolling, and about work
    // that is over.
    const el = render(
      <SubagentRows
        threads={[
          thread({ id: 'a', label: 'done first', status: 'completed' }),
          thread({ id: 'b', label: 'still going' }),
          thread({ id: 'c', label: 'failed one', status: 'failed' }),
          thread({ id: 'd', label: 'also going' }),
        ]}
      />,
    );

    expect(labels(el)).toEqual(['still going', 'also going']);
    expect(fold(el)?.textContent).toContain('2 finished');
    expect(fold(el)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows them when the fold is opened, in the order they were given', () => {
    // The finished rows are hidden, never dropped, and the panel's own grouping
    // survives inside each block — a reader who knows the cards reads the
    // popover the same way.
    const el = render(
      <SubagentRows
        threads={[
          thread({ id: 'a', label: 'second', status: 'completed' }),
          thread({ id: 'b', label: 'third', status: 'cancelled' }),
          thread({ id: 'c', label: 'first' }),
        ]}
      />,
    );
    expect(labels(el)).toEqual(['first']);

    click(fold(el)!);

    expect(labels(el)).toEqual(['first', 'second', 'third']);
    expect(fold(el)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('never folds away a delegate that has merely not FINISHED', () => {
    // The split is `isSettledRunStatus`, not `status !== 'running'`: a delegate
    // that is pending, held, or waiting on the user has not finished, and the
    // last of those is the one row that cannot advance without them. Hiding it
    // behind a control captioned "finished" is exactly the wrong place for it.
    const el = render(
      <SubagentRows
        threads={[
          thread({ id: 'a', label: 'asking', status: 'needs-input' }),
          thread({ id: 'b', label: 'queued', status: 'pending' }),
          thread({ id: 'c', label: 'holding', status: 'held' }),
          thread({ id: 'd', label: 'over', status: 'completed' }),
        ]}
      />,
    );
    expect(labels(el)).toEqual(['asking', 'queued', 'holding']);
    expect(fold(el)?.textContent).toContain('1 finished');
  });

  it('remembers the fold, because the popover is remounted on every hover', () => {
    // Component state would forget the choice between two glances at the same
    // list, which reads as the control not working.
    const first = render(
      <SubagentRows
        threads={[thread({ id: 'a', label: 'over', status: 'completed' })]}
      />,
    );
    click(fold(first)!);

    const second = render(
      <SubagentRows
        threads={[thread({ id: 'a', label: 'over', status: 'completed' })]}
      />,
    );
    expect(labels(second)).toEqual(['over']);
  });

  it('draws no fold at all when nothing has finished', () => {
    // A control counting zero is a control that does nothing, and it would sit
    // under the live rows on the commonest list there is.
    const el = render(<SubagentRows threads={[thread()]} />);
    expect(fold(el)).toBeNull();
  });

  it('states each delegate’s OWN status, so a finished one is not counted as live', () => {
    const el = render(
      <SubagentRows
        threads={[thread({ label: 'review the diff', status: 'completed' })]}
      />,
    );
    click(fold(el)!);
    const row = el.querySelector('[data-slot="subagent-row"]')!;
    expect(row.getAttribute('data-subagent-status')).toBe('completed');
    expect(row.textContent).toContain('completed');
  });

  it('leaves the rows as plain text when it was given no way to open one', () => {
    // The list never invents a surface it was not given — the same rule
    // `ShellRows` and the agents panel's own delegate rows follow. A row that
    // merely LOOKED clickable would be worse than a plain one. Asserted on the
    // ROW rather than on the panel, which now has a fold control of its own.
    const el = render(
      <SubagentRows
        threads={[thread(), thread({ id: 'b', status: 'completed' })]}
      />,
    );
    click(fold(el)!);
    for (const row of el.querySelectorAll('[data-slot="subagent-row"]')) {
      expect(row.querySelector('button')).toBeNull();
    }
  });

  it('hands back the id of the tool call that launched the delegate', () => {
    const opened: string[] = [];
    const el = render(
      <SubagentRows
        threads={[thread({ id: 'toolu_42' })]}
        onOpen={(id) => opened.push(id)}
      />,
    );
    click(el.querySelector('[data-slot="subagent-row"] button')!);
    expect(opened).toEqual(['toolu_42']);
  });

  it('opens a FINISHED delegate too, once the fold is showing it', () => {
    // The settled rows are the same row component, so a reader who folds them
    // open can still reach the conversation — the whole point of keeping them.
    const opened: string[] = [];
    const el = render(
      <SubagentRows
        threads={[thread({ id: 'toolu_9', status: 'completed' })]}
        onOpen={(id) => opened.push(id)}
      />,
    );
    click(fold(el)!);
    click(el.querySelector('[data-slot="subagent-row"] button')!);
    expect(opened).toEqual(['toolu_9']);
  });
});
