// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadForNewBundle } from '../stale-bundle';
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
  function StaleChunk(): React.JSX.Element {
    throw new TypeError(
      'Failed to fetch dynamically imported module: http://192.168.1.5:47616/assets/Stats-3f2a.js',
    );
  }

  it('reloads ONCE for a chunk the rebuilt app no longer serves', () => {
    // A phone tab outlives the Mac's updates, so its next screen change asked
    // for a chunk of the old build and crashed here.
    sessionStorage.clear();
    const reload = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary reload={reload}>
          <StaleChunk />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Loading the updated app');
  });

  it('treats a missing chunk STYLESHEET as a stale bundle too', () => {
    // vite preloads a lazy view's CSS before the module, so on a stale page a
    // view with styles fails on THIS sentence first — the Graphs page does.
    sessionStorage.clear();
    function StaleStyles(): React.JSX.Element {
      throw new Error(
        'Unable to preload CSS for http://192.168.1.5:47616/assets/Workflows-3f2a.css',
      );
    }
    const reload = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary reload={reload}>
          <StaleStyles />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Loading the updated app');
    sessionStorage.clear();
  });

  it('waits for a reload THIS page already asked for instead of showing the error', () => {
    // vite's own event reports a missing chunk before the view renders the
    // failure, and asks for the reload first — the boundary must then read
    // that as "reloading", not as a second failure moments after one.
    sessionStorage.clear();
    const first = vi.fn();
    expect(reloadForNewBundle(first)).toBe(true);
    const reload = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary reload={reload}>
          <StaleChunk />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();
    expect(first).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Loading the updated app');
    sessionStorage.clear();
  });

  it('shows the error instead of reloading again moments after a stale-bundle reload', () => {
    // A second failure right after the reload is not a stale bundle, and
    // reloading on it would loop for good. The stamp names a DIFFERENT page:
    // the one before the reload.
    sessionStorage.setItem(
      'geniro.staleBundleReloadAt',
      JSON.stringify({ at: Date.now(), page: -1 }),
    );
    const reload = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root.render(
        <ErrorBoundary reload={reload}>
          <StaleChunk />
        </ErrorBoundary>,
      );
    });
    spy.mockRestore();
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Something went wrong.');
    sessionStorage.clear();
  });

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
