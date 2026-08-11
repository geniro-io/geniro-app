// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockShell } from './block-shell';

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

function toggle(): HTMLButtonElement | null {
  return container.querySelector('button[aria-expanded]');
}

describe('BlockShell', () => {
  it('renders no disclosure control when it is not collapsible, and shows the body', () => {
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Agent communication"
          eyebrowIcon={<span />}
          header={<span>Orchestrator → Poet</span>}
          status="running">
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    expect(container.textContent).toContain('Agent communication');
    expect(container.textContent).toContain('Orchestrator → Poet');
    expect(container.textContent).toContain('inner thread');
    expect(toggle()).toBeNull();
  });

  it('starts CLOSED when collapsible, and opens on click', () => {
    // One prop decides both facts: collapsible blocks are asides the reader
    // opens deliberately, so there is no collapsible-and-already-open state to
    // ask for.
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation">
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    const button = toggle();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    // Closed: the identity line and status still read, the thread does not.
    expect(container.textContent).toContain('code-reviewer');
    expect(container.textContent).toContain('done');
    expect(container.textContent).not.toContain('inner thread');

    act(() =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('inner thread');
  });

  it('puts a header action BESIDE the disclosure, never inside it', () => {
    // Interactive content nested in a <button> is invalid HTML whatever role
    // it carries, and a control there also swallows presses meant for the
    // toggle. Both halves are asserted: the action is outside the button, and
    // pressing it does not open the block.
    const pressed: string[] = [];
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation"
          headerAction={
            <button
              type="button"
              aria-label="Open in a panel"
              onClick={() => pressed.push('action')}
            />
          }>
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    const action = container.querySelector('[aria-label="Open in a panel"]');
    expect(action).not.toBeNull();
    expect(toggle()?.contains(action)).toBe(false);

    act(() =>
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(pressed).toEqual(['action']);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('inner thread');
  });

  it('spins only while running', () => {
    const shell = (status: 'running' | 'done'): React.JSX.Element => (
      <BlockShell
        eyebrow="Sub-agent"
        eyebrowIcon={<span />}
        header={<span>code-reviewer</span>}
        status={status}
        collapsible
        toggleLabel="Show the sub-agent's conversation">
        <p>inner thread</p>
      </BlockShell>
    );

    act(() => root.render(shell('running')));
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('running');

    act(() => root.render(shell('done')));
    expect(container.querySelector('svg.animate-spin')).toBeNull();
  });
});
