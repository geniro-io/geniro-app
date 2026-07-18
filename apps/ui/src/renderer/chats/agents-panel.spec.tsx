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
  it('lists EVERY agent with status, parallel turns, used/window context + fill ring, and spend', () => {
    const el = render(<AgentsPanel agents={agents} onClose={vi.fn()} />);
    const rows = [...el.querySelectorAll('li')];
    expect(rows).toHaveLength(3);

    const worker = rows.find((row) => row.textContent?.includes('Worker'))!;
    expect(worker.textContent).toContain('3 parallel turns');
    expect(worker.textContent).toContain('ctx 12k / 200k');
    expect(worker.textContent).toContain('<$0.01');
    expect(worker.querySelector('svg.animate-spin')).not.toBeNull();
    expect(
      worker.querySelector('svg[aria-label="Context 6% full"]'),
    ).not.toBeNull();

    const orchestrator = rows.find((row) =>
      row.textContent?.includes('Orchestrator'),
    )!;
    expect(orchestrator.textContent).toContain('ctx 45.2k / 200k');
    expect(orchestrator.textContent).toContain('$0.24');
    expect(
      orchestrator.querySelector('svg[aria-label="Context 23% full"]'),
    ).not.toBeNull();

    const reviewer = rows.find((row) => row.textContent?.includes('Reviewer'))!;
    expect(reviewer.textContent).toContain('idle');
    expect(reviewer.textContent).toContain('cursor-agent');
    expect(reviewer.textContent).not.toContain('ctx');
    expect(reviewer.querySelector('svg[aria-label^="Context"]')).toBeNull();
  });

  it('the fill ring escalates its tone as the context window fills', () => {
    const withContext = (id: string, contextTokens: number): AgentDisplay => ({
      id,
      name: id,
      agent: 'claude',
      status: 'completed',
      activeTurns: 0,
      contextTokens,
      spentUsd: null,
    });
    const el = render(
      <AgentsPanel
        agents={[
          withContext('calm', 45_200), // 23% → accent
          withContext('hot', 150_000), // 75% → warning
          withContext('critical', 185_000), // 92.5% → destructive
        ]}
        onClose={vi.fn()}
      />,
    );
    const ring = (label: string): SVGElement =>
      el.querySelector<SVGElement>(`svg[aria-label="${label}"]`)!;
    expect(ring('Context 23% full').classList.contains('text-primary')).toBe(
      true,
    );
    expect(ring('Context 75% full').classList.contains('text-warning')).toBe(
      true,
    );
    expect(
      ring('Context 93% full').classList.contains('text-destructive'),
    ).toBe(true);
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
