// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDisplay } from './agent-activity';
import { ChatHeader } from './chat-header';

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

function agent(
  overrides: Partial<AgentDisplay> & { id: string },
): AgentDisplay {
  return {
    name: overrides.id,
    agent: 'claude',
    status: 'idle',
    activeTurns: 0,
    contextTokens: null,
    spentUsd: null,
    ...overrides,
  };
}

const baseProps = {
  label: 'Review team',
  isWorkflow: true,
  status: 'running' as const,
  lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  cwd: '/proj/deep/path',
  agents: [] as AgentDisplay[],
  agentsPanelOpen: false,
  onToggleAgents: vi.fn(),
};

describe('ChatHeader', () => {
  it('shows the sidebar identity — label, status, cwd — and hides the date while running', () => {
    const el = render(<ChatHeader {...baseProps} />);
    expect(el.querySelector('h2')?.textContent).toBe('Review team');
    expect(el.textContent).toContain('running');
    expect(el.textContent).toContain('/proj/deep/path');
    expect(el.querySelector('svg.animate-spin')).not.toBeNull();
    expect(el.textContent).not.toContain('1m');
  });

  it('shows the activity time once settled', () => {
    const el = render(<ChatHeader {...baseProps} status="completed" />);
    expect(el.textContent).toContain('1m');
    expect(el.querySelector('svg.animate-spin')).toBeNull();
  });

  it('caps chips at 3 — WORKING agents first — and collapses the rest into +N', () => {
    const el = render(
      <ChatHeader
        {...baseProps}
        agents={[
          agent({ id: 'a' }),
          agent({ id: 'b' }),
          agent({ id: 'worker', status: 'running', activeTurns: 2 }),
          agent({ id: 'd' }),
          agent({ id: 'e' }),
        ]}
      />,
    );
    const chips = [...el.querySelectorAll('button[aria-label^="Agent "]')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toHaveLength(3);
    // The busy worker surfaces even though it is declared third, with its
    // parallel-turn count on the chip.
    expect(chips[0]).toContain('worker');
    expect(chips[0]).toContain('×2');
    const overflow = el.querySelector('button[aria-label="Show all 5 agents"]');
    expect(overflow?.textContent).toBe('+2');
  });

  it('every agent affordance toggles the panel', () => {
    const onToggleAgents = vi.fn();
    const el = render(
      <ChatHeader
        {...baseProps}
        agents={[agent({ id: 'a' })]}
        onToggleAgents={onToggleAgents}
      />,
    );
    for (const selector of [
      'button[aria-label="Agent a: idle"]',
      'button[aria-label="Open agents panel"]',
    ]) {
      act(() => {
        el.querySelector(selector)?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
    }
    expect(onToggleAgents).toHaveBeenCalledTimes(2);
  });

  it('hides the panel toggle when the run has no agents to show', () => {
    const el = render(<ChatHeader {...baseProps} agents={[]} />);
    expect(
      el.querySelector('button[aria-label="Open agents panel"]'),
    ).toBeNull();
  });
});
