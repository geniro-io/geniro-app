// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CursorCallsCapability,
  WorkflowNode,
} from '../../shared/contracts';

const mocks = vi.hoisted(() => ({
  edges: [] as { source: string; target: string }[],
  nodes: [] as { id: string; data: { node: { kind: string } } }[],
  updateNodeInternals: vi.fn(),
  deleteElements: vi.fn(),
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
  useReactFlow: () => ({ deleteElements: mocks.deleteElements }),
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ nodes: mocks.nodes }),
}));

import { CursorCallsContext, NodeCard } from './node-card';

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

function renderWithCapability(
  node: WorkflowNode,
  capability: CursorCallsCapability | null,
): void {
  act(() => {
    root.render(
      <CursorCallsContext.Provider value={capability}>
        <NodeCard node={node} selected={false} className="w-[240px]">
          <span>header-content</span>
        </NodeCard>
      </CursorCallsContext.Provider>,
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
      'No input connected — wire a trigger, an upstream agent, or a call edge into this node.',
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

  it('degrades to the red state for a node of an unknown kind (version skew)', () => {
    // Kinds are strict everywhere now, but a newer daemon (or hand-written
    // garbage) can still hand the renderer a kind these registries don't
    // know; the card must render its error strip — not throw and blank the
    // whole app (the M-blank bug).
    const legacy = { id: 'x1', agent: 'claude' } as unknown as WorkflowNode;
    mocks.nodes = [{ id: 'x1', data: { node: {} as { kind: string } } }];
    render(legacy);
    expect(card().className).toContain('border-destructive');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unknown node kind 'undefined'",
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

  it('deletes this node (edges follow) from the card button, without bubbling a canvas click', () => {
    canvas(TRIGGER, AGENT);
    // React Flow selects a node via a synthetic onClick on its wrapper —
    // render the card under such a wrapper to pin that delete stops there.
    const wrapperClicks = vi.fn();
    act(() => {
      root.render(
        <div onClick={wrapperClicks}>
          <NodeCard node={AGENT} selected={false} className="w-[240px]">
            <span>header-content</span>
          </NodeCard>
        </div>,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete a1"]',
    )!;
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.deleteElements).toHaveBeenCalledWith({
      nodes: [{ id: 'a1' }],
    });
    expect(wrapperClicks).not.toHaveBeenCalled();
  });
});

describe('NodeCard — cursor calls degrade warning', () => {
  const CURSOR_CALLER: WorkflowNode = {
    id: 'c1',
    kind: 'agent',
    agent: 'cursor-agent',
    approval: 'auto',
  };
  const FAIL: CursorCallsCapability = {
    status: 'fail',
    version: 'v1',
    probedAt: 1,
    reason: 'no headless MCP trust',
  };
  const PASS: CursorCallsCapability = {
    status: 'pass',
    version: 'v1',
    probedAt: 1,
    reason: null,
  };

  function cursorCallerCanvas(): void {
    canvas(CURSOR_CALLER, AGENT);
    mocks.edges = [
      { source: 'c1', target: 'a1', type: 'call' } as (typeof mocks.edges)[0],
    ];
  }

  it('shows the amber note on a cursor caller when the probe failed', () => {
    cursorCallerCanvas();
    renderWithCapability(CURSOR_CALLER, FAIL);
    const note = container.querySelector('[role="note"]');
    expect(note?.textContent).toContain('Agent calls will be disabled');
    expect(note?.textContent).toContain('no headless MCP trust');
  });

  it('shows a probing note while the verdict is still unknown', () => {
    cursorCallerCanvas();
    renderWithCapability(CURSOR_CALLER, {
      ...FAIL,
      status: 'unknown',
      reason: null,
    });
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'not verified yet',
    );
  });

  it('stays silent on a pass, on a claude caller, and on a cursor node without call edges', () => {
    cursorCallerCanvas();
    renderWithCapability(CURSOR_CALLER, PASS);
    expect(container.querySelector('[role="note"]')).toBeNull();

    // claude caller with the same failed capability — not a cursor concern
    canvas(AGENT, CURSOR_CALLER);
    mocks.edges = [
      { source: 'a1', target: 'c1', type: 'call' } as (typeof mocks.edges)[0],
    ];
    renderWithCapability(AGENT, FAIL);
    expect(container.querySelector('[role="note"]')).toBeNull();

    // cursor node with only a data edge — not a caller
    canvas(CURSOR_CALLER, AGENT);
    mocks.edges = [{ source: 'c1', target: 'a1' }];
    renderWithCapability(CURSOR_CALLER, FAIL);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });
});
