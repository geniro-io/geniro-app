// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDisplay, AgentThread } from './agent-activity';
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

function click(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const mainThread: AgentThread = {
  id: 'main',
  kind: 'main',
  label: 'Main conversation',
  status: 'completed',
  sessionId: null,
};

const agents: AgentDisplay[] = [
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    agent: 'claude',
    status: 'running',
    activeTurns: 1,
    contextTokens: 45_200,
    spentUsd: 0.236,
    threads: [{ ...mainThread, status: 'running' }],
  },
  {
    id: 'worker',
    name: 'Worker',
    agent: 'claude',
    status: 'running',
    activeTurns: 3,
    contextTokens: 12_000,
    spentUsd: 0.004,
    threads: [
      {
        id: 'call-1',
        kind: 'call',
        label: 'call-1 · Write a haiku about rivers.',
        status: 'completed',
        sessionId: 'sess-call-1',
      },
      {
        id: 'call-2',
        kind: 'call',
        label: 'call-2 · Write a haiku about mountains.',
        status: 'running',
        sessionId: null,
      },
    ],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    agent: 'cursor-agent',
    status: 'idle',
    activeTurns: 0,
    contextTokens: null,
    spentUsd: null,
    threads: [mainThread],
  },
];

describe('AgentsPanel', () => {
  it('lists EVERY agent with status, active/total thread counts, context + ring, and spend', () => {
    const el = render(
      <AgentsPanel agents={agents} onOpenThread={vi.fn()} onClose={vi.fn()} />,
    );
    const rows = [...el.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(3);

    const worker = rows.find((row) => row.textContent?.includes('Worker'))!;
    expect(worker.textContent).toContain('3 active · 2 threads');
    expect(worker.textContent).toContain('ctx 12k / 200k');
    expect(worker.textContent).toContain('<$0.01');
    expect(worker.querySelector('svg.animate-spin')).not.toBeNull();
    expect(
      worker.querySelector('svg[aria-label="Context 6% full"]'),
    ).not.toBeNull();

    const orchestrator = rows.find((row) =>
      row.textContent?.includes('Orchestrator'),
    )!;
    expect(orchestrator.textContent).toContain('1 active · 1 thread');
    expect(orchestrator.textContent).toContain('ctx 45.2k / 200k');
    expect(orchestrator.textContent).toContain('$0.24');

    const reviewer = rows.find((row) => row.textContent?.includes('Reviewer'))!;
    expect(reviewer.textContent).toContain('idle');
    expect(reviewer.textContent).toContain('cursor-agent');
    expect(reviewer.textContent).not.toContain('ctx');
  });

  it('expanding an agent lists its threads; per-thread terminals need claude + a session', () => {
    const onOpenThread = vi.fn();
    const el = render(
      <AgentsPanel
        agents={agents}
        onOpenThread={onOpenThread}
        onClose={vi.fn()}
      />,
    );
    // Collapsed: no thread labels yet.
    expect(el.textContent).not.toContain('Write a haiku about rivers.');

    click(el.querySelector('button[aria-label="Worker threads"]'));
    expect(el.textContent).toContain('call-1 · Write a haiku about rivers.');
    expect(el.textContent).toContain('call-2 · Write a haiku about mountains.');

    // call-1 settled with a session id → openable; call-2 still running → not.
    const openCall1 = el.querySelector(
      'button[aria-label="Open terminal for Worker — call-1"]',
    );
    expect(openCall1).not.toBeNull();
    expect(
      el.querySelector(
        'button[aria-label="Open terminal for Worker — call-2"]',
      ),
    ).toBeNull();

    click(openCall1);
    expect(onOpenThread).toHaveBeenCalledWith(agents[1], agents[1]!.threads[0]);

    // The main thread of a claude agent opens without an explicit session.
    click(el.querySelector('button[aria-label="Orchestrator threads"]'));
    expect(
      el.querySelector(
        'button[aria-label="Open terminal for Orchestrator — main"]',
      ),
    ).not.toBeNull();

    // Cursor has no interactive mirror — threads list, but no terminal.
    click(el.querySelector('button[aria-label="Reviewer threads"]'));
    expect(
      el.querySelector(
        'button[aria-label="Open terminal for Reviewer — main"]',
      ),
    ).toBeNull();
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
      threads: [],
    });
    const el = render(
      <AgentsPanel
        agents={[
          withContext('calm', 45_200), // 23% → accent
          withContext('hot', 150_000), // 75% → warning
          withContext('critical', 185_000), // 92.5% → destructive
        ]}
        onOpenThread={vi.fn()}
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
    const el = render(
      <AgentsPanel agents={agents} onOpenThread={vi.fn()} onClose={onClose} />,
    );
    expect(
      el.querySelector('[role="separator"][aria-label="Resize agents panel"]'),
    ).not.toBeNull();
    click(el.querySelector('button[aria-label="Close agents panel"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an empty state when the run has no agents', () => {
    const el = render(
      <AgentsPanel agents={[]} onOpenThread={vi.fn()} onClose={vi.fn()} />,
    );
    expect(el.textContent).toContain('No agents in this run');
  });
});
