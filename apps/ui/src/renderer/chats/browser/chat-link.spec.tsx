// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../../__fixtures__/preload-stub';
import { ThreadUiMemoryContext, writeThreadFlag } from '../thread-ui-memory';
import { BrowserGrid } from './browser-grid';
import {
  BrowserPaneContext,
  type BrowserPaneControls,
  useBrowserPane,
} from './browser-pane-context';
import { BROWSER_PANE_OPEN_KEY } from './browser-pane-store';
import { ChatLink } from './chat-link';

const clipboard = vi.hoisted(() => ({
  writeClipboard: vi.fn((_text: string) => Promise.resolve()),
}));
vi.mock('../../clipboard', () => ({
  writeClipboard: clipboard.writeClipboard,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = 'run-1';
const HREF = 'https://github.com/geniro-io/geniro-app/pull/42';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.geniro = createPreloadStub();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  clipboard.writeClipboard.mockClear();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function controls(overrides: Partial<BrowserPaneControls> = {}) {
  return {
    openPane: vi.fn(),
    openUrl: vi.fn(),
    isOpen: vi.fn(() => true),
    ...overrides,
  } satisfies BrowserPaneControls;
}

function anchor(): HTMLAnchorElement {
  const found = container.querySelector('a');
  if (found === null) {
    throw new Error('no link rendered');
  }
  return found;
}

/** Dispatches a mouse event and reports whether its default was NOT prevented. */
function dispatch(
  target: HTMLElement,
  type: string,
  init: MouseEventInit,
): boolean {
  let notPrevented = true;
  act(() => {
    notPrevented = target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  });
  return notPrevented;
}

function click(init: MouseEventInit = { button: 0 }): boolean {
  return dispatch(anchor(), 'click', init);
}

function rightClick(): boolean {
  return dispatch(anchor(), 'contextmenu', {
    button: 2,
    clientX: 40,
    clientY: 50,
  });
}

function optionLabels(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent ?? '',
  );
}

function chooseOption(label: string): void {
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((entry) => entry.textContent === label);
  if (option === undefined) {
    throw new Error(`no menu option "${label}"`);
  }
  act(() => {
    option.click();
  });
}

describe('ChatLink — a plain click', () => {
  it('opens a web link in the chat browser while its pane is open', async () => {
    const pane = controls();
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    expect(click()).toBe(false);
    expect(pane.openUrl).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it('leaves a web link to the system browser while its pane is closed', async () => {
    const pane = controls({ isOpen: () => false });
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    expect(click()).toBe(true);
    expect(pane.openUrl).not.toHaveBeenCalled();
    expect(anchor().target).toBe('_blank');
  });

  it('keeps the system browser for a modified click and a middle click, pane open or not', async () => {
    const pane = controls();
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    expect(click({ button: 0, metaKey: true })).toBe(true);
    expect(click({ button: 0, ctrlKey: true })).toBe(true);
    expect(click({ button: 0, shiftKey: true })).toBe(true);
    expect(click({ button: 0, altKey: true })).toBe(true);
    expect(click({ button: 1 })).toBe(true);
    expect(pane.openUrl).not.toHaveBeenCalled();
  });
});

describe('ChatLink — the right-click menu', () => {
  it('opens its three choices in place of the native menu', async () => {
    await render(
      <BrowserPaneContext.Provider value={controls()}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    expect(rightClick()).toBe(false);
    expect(optionLabels()).toEqual([
      'Open in Geniro browser',
      'Open in system browser',
      'Copy link',
    ]);
  });

  it('opens the link in the Geniro browser even while its pane is closed', async () => {
    const pane = controls({ isOpen: () => false });
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    chooseOption('Open in Geniro browser');
    expect(pane.openUrl).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it('opens the link in the system browser even while its pane is open', async () => {
    const pane = controls();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    chooseOption('Open in system browser');
    expect(open).toHaveBeenCalledExactlyOnceWith(HREF, '_blank', 'noopener');
    expect(pane.openUrl).not.toHaveBeenCalled();
  });

  it('copies the link', async () => {
    await render(
      <BrowserPaneContext.Provider value={controls()}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    chooseOption('Copy link');
    expect(clipboard.writeClipboard).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it('opens from inside a paragraph without a DOM-nesting error', async () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await render(
      <BrowserPaneContext.Provider value={controls()}>
        <p>
          <ChatLink href={HREF}>pull request</ChatLink>
        </p>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    expect(optionLabels()).toHaveLength(3);
    expect(
      errors.mock.calls.filter(([message]) =>
        String(message).includes('descendant'),
      ),
    ).toEqual([]);
  });

  it('keeps a choice in the menu from reaching the row the link sits in', async () => {
    const rowClick = vi.fn();
    await render(
      <BrowserPaneContext.Provider value={controls()}>
        <div onClick={rowClick}>
          <ChatLink href={HREF}>pull request</ChatLink>
        </div>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    chooseOption('Copy link');
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('closes once a choice is made', async () => {
    await render(
      <BrowserPaneContext.Provider value={controls()}>
        <ChatLink href={HREF}>pull request</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    rightClick();
    chooseOption('Copy link');
    expect(optionLabels()).toEqual([]);
  });
});

describe('ChatLink — where the chat has no browser, or the link is not web', () => {
  it('leaves the link and its right-click to the system with no chat browser', async () => {
    await render(<ChatLink href={HREF}>pull request</ChatLink>);

    expect(click()).toBe(true);
    expect(rightClick()).toBe(true);
    expect(optionLabels()).toEqual([]);
  });

  it('leaves a mail link to the system even with a chat browser open', async () => {
    const pane = controls();
    await render(
      <BrowserPaneContext.Provider value={pane}>
        <ChatLink href="mailto:someone@example.com">write</ChatLink>
      </BrowserPaneContext.Provider>,
    );

    expect(click()).toBe(true);
    expect(rightClick()).toBe(true);
    expect(optionLabels()).toEqual([]);
    expect(pane.openUrl).not.toHaveBeenCalled();
  });
});

describe('BrowserGrid — the pane the links read', () => {
  function Probe({
    seen,
  }: {
    seen: (pane: BrowserPaneControls | null) => void;
  }) {
    seen(useBrowserPane());
    return null;
  }

  it('reports the thread flag as it changes, through the same controls object', async () => {
    const seen = vi.fn();
    await render(
      <ThreadUiMemoryContext.Provider value={RUN}>
        <BrowserGrid runId={RUN}>
          <Probe seen={seen} />
        </BrowserGrid>
      </ThreadUiMemoryContext.Provider>,
    );
    const first = seen.mock.lastCall?.[0];
    expect(first?.isOpen()).toBe(false);
    const rendered = seen.mock.calls.length;

    act(() => {
      writeThreadFlag(RUN, BROWSER_PANE_OPEN_KEY, true);
    });
    expect(first?.isOpen()).toBe(true);
    expect(seen.mock.calls.length).toBe(rendered);

    act(() => {
      writeThreadFlag(RUN, BROWSER_PANE_OPEN_KEY, false);
    });
    expect(first?.isOpen()).toBe(false);
    expect(seen.mock.calls.length).toBe(rendered);
  });

  it('opens a plain click in the chat browser only while its pane is open', async () => {
    const openTab = vi.fn(() => Promise.resolve('t1'));
    window.geniro = createPreloadStub({ browserOpenTab: openTab });
    await render(
      <ThreadUiMemoryContext.Provider value={RUN}>
        <BrowserGrid runId={RUN}>
          <ChatLink href={HREF}>pull request</ChatLink>
        </BrowserGrid>
      </ThreadUiMemoryContext.Provider>,
    );

    expect(click()).toBe(true);
    expect(openTab).not.toHaveBeenCalled();

    act(() => {
      writeThreadFlag(RUN, BROWSER_PANE_OPEN_KEY, true);
    });
    expect(click()).toBe(false);
    expect(openTab).toHaveBeenCalledExactlyOnceWith(RUN, HREF);
  });
});
