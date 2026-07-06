// @vitest-environment jsdom
import type { EdgeProps } from '@xyflow/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The edge renders standalone in jsdom: BaseEdge/EdgeLabelRenderer collapse
// to inspectable elements and the bezier math is pinned to a known path.
vi.mock('@xyflow/react', () => ({
  BaseEdge: ({
    path,
    style,
    markerEnd,
  }: {
    path: string;
    style?: React.CSSProperties;
    markerEnd?: string;
  }) => (
    <path
      data-testid="edge-path"
      d={path}
      style={style}
      markerEnd={markerEnd}
    />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label">{children}</div>
  ),
  getBezierPath: () => ['M0 0 L100 0', 50, 0],
}));

import { CallEdge } from './call-edge';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROPS = {
  id: 'a->b#call',
  source: 'a',
  target: 'b',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 0,
  sourcePosition: 'right',
  targetPosition: 'left',
} as unknown as EdgeProps;

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

function render(element: React.ReactNode): void {
  act(() => {
    root.render(element);
  });
}

describe('CallEdge', () => {
  it('draws a dashed warning-toned bezier with no chip at rest', () => {
    render(
      <svg>
        <CallEdge {...PROPS} />
      </svg>,
    );
    const path = container.querySelector('[data-testid="edge-path"]')!;
    const style = (path as SVGPathElement).style;
    // Token only — the eslint colour rule and the milestone forbid literals.
    expect(style.stroke).toBe('var(--color-warning)');
    expect(style.strokeDasharray).toBe('6 4');
    expect(container.querySelector('[data-testid="edge-label"]')).toBeNull();
    // The arrowhead makes the call DIRECTION readable: it points into the
    // callee, and the marker def is warning-toned only.
    expect(path.getAttribute('marker-end')).toBe('url(#geniro-call-arrow)');
    const marker = container.querySelector('marker#geniro-call-arrow');
    expect(marker?.querySelector('path')?.getAttribute('fill')).toBe(
      'var(--color-warning)',
    );
  });

  it('shows the call chip and a heavier stroke while selected', () => {
    render(
      <svg>
        <CallEdge {...PROPS} selected />
      </svg>,
    );
    const chip = container.querySelector('[data-testid="edge-label"]');
    expect(chip?.textContent).toBe('call');
    const path = container.querySelector('[data-testid="edge-path"]')!;
    expect((path as SVGPathElement).style.strokeWidth).toBe('2');
  });

  it('routes a BACK edge (target left of source) as a tight loop below the cards', () => {
    // A flat default bezier would run BEHIND both node cards (edges render
    // under nodes), leaving only stubs visible at the handles — the wire
    // must step out of the source, drop below both endpoints, run across,
    // and climb into the target (rounded-orthogonal feedback routing).
    render(
      <svg>
        <CallEdge
          {...PROPS}
          sourceX={100}
          sourceY={0}
          targetX={0}
          targetY={0}
        />
      </svg>,
    );
    const d = container
      .querySelector('[data-testid="edge-path"]')!
      .getAttribute('d')!;
    expect(d).toBe(
      'M 100,0 H 112 Q 124,0 124,12 V 52 Q 124,64 112,64 ' +
        'H -12 Q -24,64 -24,52 V 12 Q -24,0 -12,0 H 0',
    );
  });

  it('shows the chip on hover and hides it on leave', () => {
    render(
      <svg>
        <CallEdge {...PROPS} />
      </svg>,
    );
    const group = container.querySelector('g')!;
    act(() => {
      group.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="edge-label"]')?.textContent,
    ).toBe('call');
    act(() => {
      group.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="edge-label"]')).toBeNull();
  });
});
