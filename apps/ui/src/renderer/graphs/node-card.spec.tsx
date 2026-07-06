// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowNode } from '../../shared/contracts';

const mocks = vi.hoisted(() => ({
  edges: [] as { source: string; target: string }[],
  nodes: [] as { id: string; data: { node: { kind: string } } }[],
  updateNodeInternals: vi.fn(),
}));

// The shell reads the live canvas (edges + node kinds) through React Flow's
// store hooks; mocked so validation runs against fixture graphs in jsdom.
vi.mock('@xyflow/react', () => ({
  Handle: ({ id, type }: { id?: string; type: string }) => (
    <span data-testid="handle" data-handle-id={id} data-handle-type={type} />
  ),
  Position: { Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => mocks.updateNodeInternals,
  useEdges: () => mocks.edges,
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ nodes: mocks.nodes }),
}));

import { NodeCard } from './node-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: WorkflowNode = {
  id: 'a1',
  kind: 'agent',
  agent: 'claude',
  approval: 'auto',
};
const TRIGGER: WorkflowNode = { id: 't1', kind: 'trigger', trigger: 'manual' };

function canvas(...nodes: WorkflowNode[]): void {
  mocks.nodes = nodes.map((node) => ({
    id: node.id,
    data: { node: { kind: node.kind } },
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.edges = [];
  mocks.nodes = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: WorkflowNode, selected = false): void {
  act(() => {
    root.render(
      <NodeCard node={node} selected={selected} className="w-[240px]">
        <span>header-content</span>
      </NodeCard>,
    );
  });
}

function card(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe('NodeCard', () => {
  it('turns red with the error message when nothing feeds an agent', () => {
    canvas(AGENT);
    render(AGENT, true);
    expect(card().className).toContain('border-destructive');
    // The invalid state wins over the selection ring.
    expect(card().className).not.toContain('border-primary');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'No input connected — wire a trigger or an upstream agent into this node.',
    );
  });

  it('renders clean (and the selection ring) once the graph is valid', () => {
    canvas(TRIGGER, AGENT);
    mocks.edges = [{ source: 't1', target: 'a1' }];
    render(AGENT, true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(card().className).toContain('border-primary');
    expect(card().className).not.toContain('border-destructive');
    expect(container.textContent).toContain('header-content');
  });

  it('flags a trigger that fires nothing', () => {
    canvas(TRIGGER);
    render(TRIGGER);
    expect(card().className).toContain('border-destructive');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'This trigger fires nothing — connect it to an agent.',
    );
  });

  it('revalidates live as edges change', () => {
    canvas(TRIGGER, AGENT);
    render(AGENT);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    mocks.edges = [{ source: 't1', target: 'a1' }];
    render(AGENT);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
