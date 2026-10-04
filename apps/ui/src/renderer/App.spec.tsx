// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell's heavy children are not what this spec is about. Chats is a
// stand-in whose buttons fire the callbacks the shell hands it, so the shell's
// own reaction to them is what a spec observes.
vi.mock('./chats/Chats', () => ({
  Chats: (props: {
    onPhoneDetailChange?: (detail: boolean) => void;
    onOpenSettings?: (section: 'fast-actions') => void;
  }) => (
    <>
      <button type="button" onClick={() => props.onPhoneDetailChange?.(true)}>
        open a thread
      </button>
      <button type="button" onClick={() => props.onPhoneDetailChange?.(false)}>
        back to the list
      </button>
      <button
        type="button"
        onClick={() => props.onOpenSettings?.('fast-actions')}>
        manage fast actions
      </button>
    </>
  ),
}));
vi.mock('./daemon-client', () => ({
  DaemonClient: class {
    connect(): void {}
    close(): void {}
  },
}));
vi.mock('./terminal/terminal-panel', () => ({ TerminalPanel: () => null }));
vi.mock('./debug/debug-panel', () => ({ DebugPanel: () => null }));

import type { DaemonHandle } from '../shared/contracts';
import { createPreloadStub } from './__fixtures__/preload-stub';
import { afterPopstate } from './__tests__/after-popstate';
import { App } from './App';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** jsdom ships no `matchMedia`; the shell asks it for the narrow layout. */
function stubMatchMedia(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubMatchMedia(false);
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

describe('App — the phone’s navigation', () => {
  it('navigates from a bottom tab bar, with the rail and its old drawer button gone below `sm`', async () => {
    stubMatchMedia(true);
    window.geniro = createPreloadStub();

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    const bar = container.querySelector<HTMLElement>(
      '[data-slot="bottom-tab-bar"]',
    )!;
    const current = (): string | null | undefined =>
      bar
        .querySelector('button[aria-current="page"]')
        ?.getAttribute('aria-label');
    expect(current()).toBe('Chats');
    // The rail stays for wider widths only, and the hamburger is gone.
    const rail = container.querySelector('button[aria-label="Collapse menu"]');
    expect(rail).not.toBeNull();
    expect(rail!.closest('.max-sm\\:hidden')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Open navigation"]'),
    ).toBeNull();

    await act(async () => {
      bar
        .querySelector<HTMLButtonElement>('button[aria-label="Stats"]')!
        .click();
    });
    await flush();
    expect(current()).toBe('Stats');
  });
});

describe('App — phone pages and the tab bar', () => {
  const press = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(
      (node) =>
        node.textContent?.trim() === label ||
        node.getAttribute('aria-label') === label,
    )!;
    await act(async () => {
      button.click();
    });
    await flush();
  };
  const tabBar = (): Element | null =>
    container.querySelector('[data-slot="bottom-tab-bar"]');
  const title = (): string | null | undefined =>
    container.querySelector('[data-slot="titlebar-title"]')?.textContent;
  const sectionsNav = (): Element | null =>
    container.querySelector('nav[aria-label="Settings sections"]');
  const backToSettings = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to settings"]',
    );
  /** Settings is a lazy chunk: wait for it to replace the Suspense fallback. */
  const waitForSettings = async (): Promise<void> => {
    for (let tries = 0; tries < 100 && !sectionsNav(); tries += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    if (!sectionsNav()) {
      throw new Error('Settings never replaced its Suspense fallback');
    }
  };
  const afterPop = async (go: () => void): Promise<void> => {
    await afterPopstate(go);
    await flush();
  };

  beforeEach(async () => {
    // App opens on the view the address names, and an earlier spec leaves
    // its own there.
    history.replaceState(null, '', '#/chats');
    stubMatchMedia(true);
    const handle: DaemonHandle = {
      host: '127.0.0.1',
      port: 1,
      token: 't',
      version: '0.0.0',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    window.geniro = createPreloadStub({
      getDaemonHandle: () => Promise.resolve(handle),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hides the tab bar on a chat DETAIL page and names the list page after the tab', async () => {
    expect(tabBar()).not.toBeNull();
    expect(title()).toBe('Chats');

    await press('open a thread');
    expect(tabBar()).toBeNull();
    expect(title()).toBe('New chat');

    await press('back to the list');
    expect(tabBar()).not.toBeNull();
    expect(title()).toBe('Chats');
  });

  it('answers the phone’s own back gesture in a Settings section by returning to the list of sections', async () => {
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');
    expect(backToSettings()).not.toBeNull();

    // The real traversal, so the shell's `hashchange` handling runs too.
    await afterPop(() => history.back());

    expect(backToSettings()).toBeNull();
    expect(sectionsNav()).not.toBeNull();
    expect(location.hash).toBe('#/settings');
  });

  it('takes the section’s own ‹ Back through history, landing on the list of sections', async () => {
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');

    await afterPop(() => backToSettings()!.click());

    expect(backToSettings()).toBeNull();
    expect(sectionsNav()).not.toBeNull();
  });

  it('reuses the section’s entry after a hop to another tab and back, so one back still reaches the list', async () => {
    const push = vi.spyOn(history, 'pushState');
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');
    // The hop rewrites the section's entry to the other tab's hash — which
    // must keep the entry's mark, or the section cannot recognise it again.
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Chats"]')!
        .click();
    });
    await flush();
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    expect(backToSettings()).not.toBeNull();

    expect(push).toHaveBeenCalledTimes(1);
    await afterPop(() => history.back());
    expect(backToSettings()).toBeNull();
    expect(location.hash).toBe('#/settings');
  });

  it('pushes no history entry for a Settings section on a WIDE window, where sections are not pages', async () => {
    act(() => root.unmount());
    root = createRoot(container);
    history.replaceState(null, '', '#/settings');
    stubMatchMedia(false);
    const push = vi.spyOn(history, 'pushState');
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    await waitForSettings();

    await press('Fast actions');

    expect(push).not.toHaveBeenCalled();
  });

  it('lands a jump from the composer page INSIDE the Settings section, with the tab bar back, and back from it stays in Settings', async () => {
    // The real jump ("Manage fast actions") is pressed on the composer — a
    // DETAIL page, which has hidden the tab bar — and flips the view and the
    // section open in ONE commit.
    await press('open a thread');
    await press('manage fast actions');
    await waitForSettings();
    expect(backToSettings()).not.toBeNull();
    expect(tabBar()).not.toBeNull();

    // Re-pressing the Settings tab pops the section's entry. The entry under
    // it must name Settings, not the Chats screen the jump came from.
    await afterPop(() =>
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click(),
    );

    expect(backToSettings()).toBeNull();
    expect(sectionsNav()).not.toBeNull();
    expect(location.hash).toBe('#/settings');
  });
});
