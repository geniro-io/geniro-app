// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './error-boundary';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function Bomb(): React.JSX.Element {
  throw new Error('kaboom from a component');
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <p>all good</p>
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toContain('all good');
  });

  it('catches a child crash and shows the message instead of a blank window', () => {
    // React logs the error loudly even when a boundary catches it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();
    expect(container.textContent).toContain('Something went wrong.');
    expect(container.textContent).toContain('kaboom from a component');
    expect(container.querySelector('button')?.textContent).toBe('Reload');
  });
});
