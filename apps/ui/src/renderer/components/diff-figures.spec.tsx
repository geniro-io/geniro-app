// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffFigures } from './diff-figures';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.JSX.Element): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

/** The two figure spans in document order: added, then removed. */
function figures(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('span > span'));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('DiffFigures', () => {
  it('draws a measured zero bare and muted, never as "+0" or "−0"', () => {
    // A zero asserts a measurement of nothing, which is a real answer, so it is drawn. It carries no
    // direction, so it has no sign, and no tone, since a pure addition is most of any diff.
    const [added, removed] = figures(
      render(<DiffFigures added={0} removed={0} />),
    );

    expect(added?.textContent).toBe('0');
    expect(removed?.textContent).toBe('0');
    expect(added?.className).toContain('text-muted-foreground');
    expect(removed?.className).toContain('text-muted-foreground');
  });

  it('signs a count that moved, in the tone of its direction', () => {
    const [added, removed] = figures(
      render(<DiffFigures added={12} removed={3} />),
    );

    expect(added?.textContent).toBe('+12');
    expect(added?.className).toContain('text-success');
    expect(removed?.textContent).toBe('−3');
    expect(removed?.className).toContain('text-destructive');
  });

  it('draws an unmeasured side as nothing, never as a zero', () => {
    // A zero here would claim the change measured nothing, which is not what happened: nothing was
    // measured at all. The other side keeps its own figure.
    const [added, removed] = figures(
      render(<DiffFigures added={null} removed={4} />),
    );

    expect(added?.textContent).toBe('');
    expect(removed?.textContent).toBe('−4');
  });

  it('keeps both columns of a list reserved when one side is unmeasured, so the rows line up', () => {
    // The reservation is what stops one unmeasured row pulling its neighbours' figures out of line.
    const [added, removed] = figures(
      render(<DiffFigures added={null} removed={4} layout="columns" />),
    );

    expect(added?.className).toContain('w-12');
    expect(removed?.className).toContain('w-10');
  });

  it('draws nothing at all for an inline pair with neither side measured', () => {
    // A chip with nothing to say is not drawn, rather than an empty chip that reads as a zero.
    const host = render(<DiffFigures added={null} removed={null} />);

    expect(host.innerHTML).toBe('');
  });
});
