// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserRunState, GeniroApi } from '../../../shared/contracts';
import { createPreloadStub } from '../../__fixtures__/preload-stub';
import { stubResizeObserver } from '../../__tests__/stub-resize-observer';
import { browserWindowApp } from './browser-window-root';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const POPPED_OUT: BrowserRunState = {
  runId: 'run-1',
  tabs: [
    {
      id: 't1',
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
      openedBy: null,
      ownCookiesLabel: null,
      drivenBy: null,
      authRequest: null,
    },
  ],
  activeTabId: 't1',
  poppedOut: true,
  recent: [],
};

let container: HTMLDivElement;
let root: Root;
let setBounds: ReturnType<typeof vi.fn<GeniroApi['browserSetBounds']>>;
let flushed: ReturnType<typeof vi.fn<GeniroApi['lineMeasurementsFlushed']>>;
let askFlush: ((requestId: string) => void) | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setBounds = vi.fn(() => Promise.resolve());
  flushed = vi.fn(() => Promise.resolve());
  askFlush = null;
  window.geniro = createPreloadStub({
    browserState: () => Promise.resolve(POPPED_OUT),
    browserSetBounds: setBounds,
    lineMeasurementsFlushed: flushed,
    onFlushLineMeasurements: (listener) => {
      askFlush = listener;
      return () => {
        askFlush = null;
      };
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const box =
        this.getAttribute('role') === 'tabpanel'
          ? { left: 0, top: 90, width: 800, height: 500 }
          : { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...box,
        x: box.left,
        y: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        toJSON: () => box,
      };
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderWindow(): Promise<void> {
  const App = browserWindowApp({ runId: 'run-1', title: 'Fix the build' });
  await act(async () => {
    root.render(<App />);
  });
}

describe('browser window root', () => {
  it("draws the chat's tabs and places the page while popped out", async () => {
    await renderWindow();

    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Open in its own window');
    expect(setBounds).toHaveBeenCalledWith('run-1', {
      x: 0,
      y: 90,
      width: 800,
      height: 500,
    });
  });

  it('answers a line-measurement flush at once, holding none', async () => {
    await renderWindow();

    await act(async () => askFlush?.('restart-1'));

    await vi.waitFor(() =>
      expect(flushed).toHaveBeenCalledExactlyOnceWith('restart-1'),
    );
  });
});
