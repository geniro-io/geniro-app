// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateNodeInternals: vi.fn(),
}));

// React Flow needs a live canvas store; the node cards only consume this
// narrow surface, mocked so the ports block renders standalone in jsdom.
vi.mock('@xyflow/react', () => ({
  Handle: ({
    id,
    type,
    style,
  }: {
    id?: string;
    type: string;
    style?: React.CSSProperties;
  }) => (
    <span
      data-testid="handle"
      data-handle-id={id}
      data-handle-type={type}
      data-hidden={style?.background === 'transparent' ? 'true' : 'false'}
    />
  ),
  Position: { Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => mocks.updateNodeInternals,
}));

import { NodePorts } from './node-ports';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactNode): void {
  act(() => {
    root.render(element);
  });
}

function handles(): { id: string | null; hidden: boolean }[] {
  return [...container.querySelectorAll('[data-testid="handle"]')].map(
    (el) => ({
      id: el.getAttribute('data-handle-id'),
      hidden: el.getAttribute('data-hidden') === 'true',
    }),
  );
}

function toggle(): void {
  const button = container.querySelector('button')!;
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('NodePorts', () => {
  it('collapsed by default: summary pills with every rule handle stacked', () => {
    render(
      <NodePorts
        nodeId="a1"
        kind="agent"
        missingInput={false}
        missingOutput={false}
      />,
    );
    // Geniro's collapsed slots: both sides show the same two-line pill —
    // plural label + rule-type count — so input and output stay symmetric.
    expect(container.textContent).toContain('inputs');
    expect(container.textContent).toContain('outputs');
    expect(container.textContent).toContain('2 connections');
    expect(container.textContent).toContain('1 connection');
    // Per-type labels are NOT visible while collapsed.
    expect(container.textContent).not.toContain('trigger');
    // All three rule handles exist (edges stay attached), only the top of
    // each stack is painted.
    expect(handles()).toEqual([
      { id: 'target-kind-agent', hidden: false },
      { id: 'target-kind-trigger', hidden: true },
      { id: 'source-kind-agent', hidden: false },
    ]);
    expect(
      container.querySelector('[aria-label="Expand ports"]'),
    ).not.toBeNull();
  });

  it('expanded: one labeled row per connection type, all handles painted', () => {
    render(
      <NodePorts
        nodeId="a1"
        kind="agent"
        missingInput={false}
        missingOutput={false}
      />,
    );
    toggle();
    // Each rule type gets its own visible label…
    expect(container.textContent).toContain('agent');
    expect(container.textContent).toContain('trigger');
    // …with its arity flag, and no summary pills anymore.
    expect(container.textContent).toContain('multiple');
    expect(container.textContent).not.toContain('connection');
    expect(handles().every((h) => !h.hidden)).toBe(true);
    const button = container.querySelector('[aria-label="Collapse ports"]');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    // React Flow re-measures the moved handles after the toggle.
    expect(mocks.updateNodeInternals).toHaveBeenLastCalledWith('a1');
  });

  it('renders no input side for a trigger (nothing may feed it)', () => {
    render(
      <NodePorts
        nodeId="t1"
        kind="trigger"
        missingInput={false}
        missingOutput={false}
      />,
    );
    expect(container.textContent).not.toContain('input');
    expect(container.textContent).toContain('outputs');
    expect(container.textContent).toContain('1 connection');
    expect(handles()).toEqual([{ id: 'source-kind-agent', hidden: false }]);
  });

  it('tints a side destructive when its requirement is unmet', () => {
    render(
      <NodePorts
        nodeId="a1"
        kind="agent"
        missingInput={true}
        missingOutput={false}
      />,
    );
    const byTone = (tone: string): Element | undefined =>
      [...container.querySelectorAll('div')].find((el) =>
        el.className.includes(tone),
      );
    // The unmet input side goes destructive; the satisfied output side keeps
    // its normal success tone.
    expect(byTone('text-destructive')?.textContent).toContain('input');
    expect(byTone('text-success')?.textContent).toContain('output');
    expect(byTone('text-primary')).toBeUndefined();
  });
});
