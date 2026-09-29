// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderLoadedApp } from './boot-app';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('renderLoadedApp', () => {
  it('renders the app once its chunk has loaded', async () => {
    await act(async () => {
      await renderLoadedApp(root, () =>
        Promise.resolve({ App: () => <p>the app</p> }),
      );
    });

    expect(container.textContent).toContain('the app');
  });

  it('reloads once when the app chunk itself is gone — never a blank window', async () => {
    // The app is a chunk like any lazy view: a page kept across an update asks
    // for the OLD build's file. Uncaught, that was an empty window.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();

    await act(async () => {
      await renderLoadedApp(
        root,
        () =>
          Promise.reject(new TypeError('Importing a module script failed.')),
        reload,
      );
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Loading the updated app');
  });

  it('shows any other load failure instead of an empty window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();

    await act(async () => {
      await renderLoadedApp(
        root,
        () => Promise.reject(new Error('the app chunk threw while loading')),
        reload,
      );
    });

    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Something went wrong.');
    expect(container.textContent).toContain(
      'the app chunk threw while loading',
    );
  });
});
