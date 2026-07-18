// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDisplay } from './agent-activity';
import { AgentsPanel } from './agents-panel';

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
  localStorage.clear();
});

const agents: AgentDisplay[] = [
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    agent: 'claude',
    status: 'running',
    activeTurns: 1,
    contextTokens: 45_200,
    spentUsd: 0.236,
  },
  {
    id: 'worker',
    name: 'Worker',
    agent: 'claude',
    status: 'running',
    activeTurns: 3,
    contextTokens: 12_000,
    spentUsd: 0.004,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    agent: 'cursor-agent',
    status: 'idle',
    activeTurns: 0,
    contextTokens: null,
    spentUsd: null,
  },
];

describe('AgentsPanel', () => {
  it('lists EVERY agent with status, parallel turns, context, and spend', () => {
    const el = render(<AgentsPanel agents={agents} onClose={vi.fn()} />);
    const rows = [...el.querySelectorAll('li')];
    expect(rows).toHaveLength(3);

    const worker = rows.find((row) => row.textContent?.includes('Worker'))!;
    expect(worker.textContent).toContain('3 parallel turns');
    expect(worker.textContent).toContain('ctx 12k');
    expect(worker.textContent).toContain('<$0.01');
    expect(worker.querySelector('svg.animate-spin')).not.toBeNull();

    const orchestrator = rows.find((row) =>
      row.textContent?.includes('Orchestrator'),
    )!;
    expect(orchestrator.textContent).toContain('ctx 45.2k');
    expect(orchestrator.textContent).toContain('$0.24');

    const reviewer = rows.find((row) => row.textContent?.includes('Reviewer'))!;
    expect(reviewer.textContent).toContain('idle');
    expect(reviewer.textContent).toContain('cursor-agent');
    expect(reviewer.textContent).not.toContain('ctx');
  });

  it('closes via the ✕ and offers the resize handle', () => {
    const onClose = vi.fn();
    const el = render(<AgentsPanel agents={agents} onClose={onClose} />);
    expect(
      el.querySelector('[role="separator"][aria-label="Resize agents panel"]'),
    ).not.toBeNull();
    act(() => {
      el.querySelector(
        'button[aria-label="Close agents panel"]',
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an empty state when the run has no agents', () => {
    const el = render(<AgentsPanel agents={[]} onClose={vi.fn()} />);
    expect(el.textContent).toContain('No agents in this run');
  });
});
