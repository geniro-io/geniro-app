// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell's heavy children are not what this spec is about, and with no
// daemon handle the chat view is never rendered anyway.
vi.mock('./chats/Chats', () => ({ Chats: () => null }));
vi.mock('./terminal/terminal-panel', () => ({ TerminalPanel: () => null }));
vi.mock('./debug/debug-panel', () => ({ DebugPanel: () => null }));

import type { DaemonHandle } from '../shared/contracts';
import { createPreloadStub } from './__fixtures__/preload-stub';
import { App } from './App';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom ships no `matchMedia`; the shell asks it for the narrow layout.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { geniro?: unknown }).geniro;
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('App — the connection banner’s Retry', () => {
  it('asks main to START the daemon, rather than re-reading a handle that does not exist', async () => {
    // A daemon that died, or never came up, has no handle — so a Retry that
    // only called `getDaemonHandle` could never bring it back, however often
    // it was pressed.
    const getDaemonHandle = vi.fn((): Promise<DaemonHandle | null> =>
      Promise.resolve(null),
    );
    const ensureDaemon = vi.fn((): Promise<DaemonHandle> =>
      Promise.reject(
        new Error('daemon pid 7 is running but not answering its health check'),
      ),
    );
    window.geniro = createPreloadStub({ getDaemonHandle, ensureDaemon });

    await act(async () => {
      root.render(<App />);
    });
    await flush();
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeDefined();
    expect(ensureDaemon).not.toHaveBeenCalled();

    await act(async () => {
      retry!.click();
    });
    await flush();

    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    // The supervisor's own reason reaches the banner.
    expect(container.textContent).toContain('not answering its health check');
  });
});
