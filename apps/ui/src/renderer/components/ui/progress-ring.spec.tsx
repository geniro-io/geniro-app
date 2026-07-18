// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ProgressRing } from './progress-ring';

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

/** The arc's drawn length — the first number of its stroke-dasharray. */
function arcLength(el: HTMLElement): number {
  const arc = el.querySelectorAll('circle')[1]!;
  return Number(arc.getAttribute('stroke-dasharray')!.split(' ')[0]);
}

describe('ProgressRing', () => {
  it('draws the arc proportional to the fraction', () => {
    const half = render(<ProgressRing fraction={0.5} label="half" />);
    const full = render(<ProgressRing fraction={1} label="full" />);
    expect(arcLength(half)).toBeCloseTo(arcLength(full) / 2);
  });

  it('clamps out-of-range fractions instead of overdrawing', () => {
    const over = render(<ProgressRing fraction={1.5} label="over" />);
    const full = render(<ProgressRing fraction={1} label="full" />);
    expect(arcLength(over)).toBeCloseTo(arcLength(full));
    const under = render(<ProgressRing fraction={-0.5} label="under" />);
    expect(arcLength(under)).toBe(0);
  });

  it('is an img with the given label, or hidden decoration without one', () => {
    const labelled = render(
      <ProgressRing fraction={0.2} label="Context 20% full" />,
    );
    const svg = labelled.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Context 20% full');
    const bare = render(<ProgressRing fraction={0.2} />);
    expect(bare.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });
});
