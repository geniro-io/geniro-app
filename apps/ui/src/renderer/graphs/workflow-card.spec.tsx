// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowSummary } from '../../shared/contracts';
import { WorkflowCard } from './workflow-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SUMMARY: WorkflowSummary = {
  slug: 'review-team',
  name: 'Review Team',
  description: 'Coder then reviewer',
  nodeCount: 3,
  edgeCount: 2,
  agentCounts: [
    { kind: 'claude', count: 2 },
    { kind: 'cursor-agent', count: 1 },
  ],
  updatedAt: new Date().toISOString(),
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
  vi.restoreAllMocks();
});

function render(
  summary: WorkflowSummary,
  onOpen: () => void = vi.fn(),
): HTMLElement {
  act(() => {
    root.render(<WorkflowCard summary={summary} onOpen={onOpen} />);
  });
  const el = container.querySelector<HTMLElement>('[role="button"]');
  if (!el) {
    throw new Error('WorkflowCard did not render a clickable element');
  }
  return el;
}

describe('WorkflowCard', () => {
  it('shows the name, description, agent breakdown, and node/edge counts', () => {
    render(SUMMARY);
    const text = container.textContent ?? '';
    expect(text).toContain('Review Team');
    expect(text).toContain('Coder then reviewer');
    // The agent breakdown is the "how many agents" signal — a real tally per
    // kind, not just the node count.
    expect(text).toContain('claude ×2');
    expect(text).toContain('cursor-agent ×1');
    expect(text).toContain('3 nodes');
    expect(text).toContain('2 edges');
  });

  it('pluralizes a single node/edge without a trailing "s"', () => {
    const text =
      render({ ...SUMMARY, nodeCount: 1, edgeCount: 1 }).textContent ?? '';
    expect(text).toContain('1 node');
    expect(text).not.toContain('1 nodes');
    expect(text).toContain('1 edge');
    expect(text).not.toContain('1 edges');
  });

  it('falls back to "No description" when there is none', () => {
    const text = render({ ...SUMMARY, description: null }).textContent ?? '';
    expect(text).toContain('No description');
  });

  it('opens on click and on keyboard Enter (it is a real button)', () => {
    const onOpen = vi.fn();
    const el = render(SUMMARY, onOpen);

    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
