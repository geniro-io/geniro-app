// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentThread } from './agent-activity';
import { SubagentRows } from './subagent-list';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

describe('SubagentRows', () => {
  it('says so in words when there are no delegates to list', () => {
    // A panel with nothing in it reads as a readout that failed to load. The
    // shelf chip that draws this never appears empty, but the sentence belongs
    // to the component so the next surface to hang it off a count that IS drawn
    // at zero gets it for free.
    const el = render(<SubagentRows threads={[]} />);
    expect(el.textContent).toContain('No sub-agents yet');
  });

  it('puts the WORKING delegates first, whatever order they arrive in', () => {
    // The rows arrive in the agents panel's own order, which groups them under
    // the agent that launched each — right for a column of cards, wrong for one
    // flat list: a fan-out that spawned forty and finished thirty-eight buries
    // the two live ones in the middle of a scrolling popover. The panel answers
    // that by folding its settled rows away; this list cannot fold, so it
    // sorts.
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

    expect(labels(el)).toEqual([
      'still going',
      'also going',
      'done first',
      'failed one',
    ]);
  });

  it('keeps the given order WITHIN each half', () => {
    // The sort is stable, so the panel's own grouping survives inside the
    // running block and inside the settled one — a reader who knows the cards
    // reads the popover the same way.
    const el = render(
      <SubagentRows
        threads={[
          thread({ id: 'a', label: 'second', status: 'completed' }),
          thread({ id: 'b', label: 'third', status: 'cancelled' }),
          thread({ id: 'c', label: 'first' }),
        ]}
      />,
    );
    expect(labels(el)).toEqual(['first', 'second', 'third']);
  });

  it('states each delegate’s OWN status, so a finished one is not counted as live', () => {
    const el = render(
      <SubagentRows
        threads={[thread({ label: 'review the diff', status: 'completed' })]}
      />,
    );
    const row = el.querySelector('[data-slot="subagent-row"]')!;
    expect(row.getAttribute('data-subagent-status')).toBe('completed');
    expect(row.textContent).toContain('completed');
  });

  it('leaves the rows as plain text when it was given no way to open one', () => {
    // The list never invents a surface it was not given — the same rule
    // `ShellRows` and the agents panel's own delegate rows follow. A row that
    // merely LOOKED clickable would be worse than a plain one.
    const el = render(<SubagentRows threads={[thread()]} />);
    expect(el.querySelector('button')).toBeNull();
  });

  it('hands back the id of the tool call that launched the delegate', () => {
    const opened: string[] = [];
    const el = render(
      <SubagentRows
        threads={[thread({ id: 'toolu_42' })]}
        onOpen={(id) => opened.push(id)}
      />,
    );
    act(() => {
      el.querySelector('button')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(opened).toEqual(['toolu_42']);
  });
});
