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

  it('keeps a long message inside the box instead of past it', () => {
    // The `overflow-auto` on that <pre> did nothing for as long as it shipped:
    // a <pre> does not wrap, so its min-content width is the whole line, and a
    // flex item's automatic `min-width: auto` refuses to shrink below that.
    // The box grew past the padding and crossed the surrounding border rather
    // than ever scrolling — reported against a 384px frame, and reachable in
    // the app in any narrow window, this being the ROOT boundary.
    //
    // Pinned on the CLASSES because jsdom computes no layout: measured in the
    // real catalog, the fix takes the box from overflowing to 31px inside the
    // card on both sides, with scrollWidth 361 over clientWidth 296. These two
    // utilities ARE the fix, not a proxy for it — `min-w-0` lifts the floor and
    // `w-full` gives the box a width for `max-w-xl` to cap.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();

    const box = container.querySelector('pre')?.className;
    expect(box).toContain('min-w-0');
    expect(box).toContain('w-full');
    expect(box).toContain('overflow-auto');
  });
});
