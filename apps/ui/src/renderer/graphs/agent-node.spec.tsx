// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowAgentNode } from '../../shared/contracts';

// The canvas card renders inside the shared NodeCard shell (React Flow store
// hooks); stub it to a plain wrapper so this spec exercises only the agent
// header — the approval chip in particular.
vi.mock('./node-card', () => ({
  NodeCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="node-card">{children}</div>
  ),
}));
vi.mock('./agent-avatar', () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
}));

import { AgentNode } from './agent-node';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderNode(approval: WorkflowAgentNode['approval']): HTMLDivElement {
  const node: WorkflowAgentNode = {
    id: 'a1',
    kind: 'agent',
    agent: 'claude',
    approval,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Only `data.node` and `selected` are read; the rest of NodeProps is cast.
  const props = {
    id: 'a1',
    data: { node },
    selected: false,
  } as unknown as React.ComponentProps<typeof AgentNode>;
  act(() => {
    root!.render(<AgentNode {...props} />);
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

describe('AgentNode approval chip', () => {
  it('shows no approval chip for an auto node', () => {
    const el = renderNode('auto');
    expect(
      el.querySelector('[aria-label="Asks before tool calls"]'),
    ).toBeNull();
    expect(
      el.querySelector('[aria-label="Auto-approves edits, asks for the rest"]'),
    ).toBeNull();
  });

  it('shows the ask chip for an ask node', () => {
    const el = renderNode('ask');
    expect(
      el.querySelector('[aria-label="Asks before tool calls"]'),
    ).not.toBeNull();
  });

  it('shows a distinct chip for the widened acceptEdits node — not indistinguishable from auto', () => {
    const el = renderNode('acceptEdits');
    expect(
      el.querySelector('[aria-label="Auto-approves edits, asks for the rest"]'),
    ).not.toBeNull();
  });
});
