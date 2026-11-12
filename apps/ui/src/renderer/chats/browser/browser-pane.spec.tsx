// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserRunState,
  BrowserStateEvent,
  BrowserTabState,
  GeniroApi,
} from '../../../shared/contracts';
import { createPreloadStub } from '../../__fixtures__/preload-stub';
import { stubResizeObserver } from '../../__tests__/stub-resize-observer';
import { Dialog } from '../../components/ui/dialog';
import { readThreadFlag, ThreadUiMemoryContext } from '../thread-ui-memory';
import { BrowserColumn } from './browser-column';
import { BrowserGrid } from './browser-grid';
import { BrowserPane } from './browser-pane';
import { BROWSER_PANE_OPEN_KEY } from './browser-pane-store';
import { BrowserToggleButton } from './browser-toggle-button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const RUN = 'run-1';
const PLACEHOLDER = { left: 10, top: 20, width: 300, height: 200 };

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
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
    ...overrides,
  };
}

function run(tabs: BrowserTabState[], extra: Partial<BrowserRunState> = {}) {
  return {
    runId: RUN,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    poppedOut: false,
    recent: [],
    ...extra,
  } satisfies BrowserRunState;
}

let container: HTMLDivElement;
let root: Root;
let overrides: Partial<GeniroApi>;
let setBounds: ReturnType<typeof vi.fn<GeniroApi['browserSetBounds']>>;
let capture: ReturnType<typeof vi.fn<GeniroApi['browserCapture']>>;
let listeners: ((event: BrowserStateEvent) => void)[];

function showState(state: BrowserRunState): void {
  overrides.browserState = () => Promise.resolve(state);
  window.geniro = createPreloadStub(overrides);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listeners = [];
  setBounds = vi.fn(() => Promise.resolve());
  capture = vi.fn(() => Promise.resolve('data:image/png;base64,AAAA'));
  overrides = {
    browserSetBounds: setBounds,
    browserCapture: capture,
    onBrowserState: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  };
  showState(run([tab()]));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const placeholder = this.getAttribute('role') === 'tabpanel';
      const box = placeholder
        ? PLACEHOLDER
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
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === label ||
      candidate.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`no button "${label}"`);
  }
  return found;
}

describe('BrowserPane', () => {
  it('sends the placeholder bounds and hides the view while a dialog is open', async () => {
    const pane = (dialogOpen: boolean): React.ReactElement => (
      <>
        <BrowserPane runId={RUN} visible onClose={() => undefined} />
        <Dialog open={dialogOpen} onClose={() => undefined} title="Sure?">
          Confirm
        </Dialog>
      </>
    );
    await render(pane(false));

    expect(setBounds).toHaveBeenLastCalledWith(RUN, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });

    setBounds.mockClear();
    await render(pane(true));

    expect(capture).toHaveBeenCalledWith(RUN);
    expect(setBounds).toHaveBeenLastCalledWith(RUN, null);
    expect(
      container
        .querySelector('[data-slot="browser-still"]')
        ?.getAttribute('src'),
    ).toBe('data:image/png;base64,AAAA');

    await render(pane(false));

    expect(setBounds).toHaveBeenLastCalledWith(RUN, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(container.querySelector('[data-slot="browser-still"]')).toBeNull();
  });

  it('sends no bounds while the pane is hidden or unmounted', async () => {
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);
    setBounds.mockClear();
    await render(
      <BrowserPane runId={RUN} visible={false} onClose={() => undefined} />,
    );
    expect(setBounds).toHaveBeenLastCalledWith(RUN, null);
  });

  it('shows the driving banner and stops the agent', async () => {
    const stop = vi.fn(() => Promise.resolve());
    overrides.browserStopAgent = stop;
    showState(run([tab({ drivenBy: 'Engineer' })]));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(
      container.querySelector('[data-slot="browser-driving-banner"]')
        ?.textContent,
    ).toContain('Engineer is driving this tab');

    await act(async () => button('Stop').click());

    expect(stop).toHaveBeenCalledExactlyOnceWith(RUN, 't1');
  });

  it('draws no driving banner for a tab nobody drives', async () => {
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);
    expect(
      container.querySelector('[data-slot="browser-driving-banner"]'),
    ).toBeNull();
  });

  it('offers Continue anyway on a certificate error, and hides the view for it', async () => {
    const proceed = vi.fn(() => Promise.resolve());
    overrides.browserContinueInsecure = proceed;
    showState(
      run([
        tab({
          error: {
            code: -202,
            description: 'net::ERR_CERT_AUTHORITY_INVALID',
            url: 'https://self-signed.test/',
            certificate: true,
          },
        }),
      ]),
    );
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(container.textContent).toContain('net::ERR_CERT_AUTHORITY_INVALID');
    expect(setBounds).not.toHaveBeenCalledWith(RUN, expect.anything());

    await act(async () => button('Continue anyway').click());

    expect(proceed).toHaveBeenCalledExactlyOnceWith(RUN, 't1');
  });

  it('offers no Continue anyway for an ordinary load failure', async () => {
    showState(
      run([
        tab({
          error: {
            code: -105,
            description: 'net::ERR_NAME_NOT_RESOLVED',
            url: 'https://nope.test/',
            certificate: false,
          },
        }),
      ]),
    );
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(container.textContent).not.toContain('Continue anyway');
    expect(container.textContent).toContain('Try again');
  });

  it('answers a basic-auth challenge with what the user typed', async () => {
    const answer = vi.fn(() => Promise.resolve());
    overrides.browserAnswerAuth = answer;
    showState(
      run([
        tab({ authRequest: { host: 'staging.acme.dev', realm: 'Staging' } }),
      ]),
    );
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    const field = (label: string): HTMLInputElement => {
      const input = container.querySelector<HTMLInputElement>(
        `input[aria-label="${label}"]`,
      );
      if (input === null) {
        throw new Error(`no field ${label}`);
      }
      return input;
    };
    const setValue = (input: HTMLInputElement, value: string): void => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setValue(field('Username'), 'anna');
      setValue(field('Password'), 's3cret');
    });
    await act(async () => button('Sign in').click());

    expect(answer).toHaveBeenCalledExactlyOnceWith(RUN, 't1', {
      username: 'anna',
      password: 's3cret',
    });
  });

  it('marks an own-cookie tab and an agent-opened one', async () => {
    showState(run([tab({ ownCookiesLabel: 'anna', openedBy: 'Engineer' })]));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    const marks = container.querySelector('[data-slot="browser-tab-marks"]');
    expect(marks?.textContent).toContain('anna · own cookies');
    expect(marks?.textContent).toContain('Engineer');
  });

  it('shows Dock back instead of the view while popped out', async () => {
    const dock = vi.fn(() => Promise.resolve());
    overrides.browserDock = dock;
    showState(run([tab()], { poppedOut: true }));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(container.textContent).toContain('Open in its own window');
    expect(setBounds).not.toHaveBeenCalledWith(RUN, expect.anything());

    await act(async () => button('Dock back').click());

    expect(dock).toHaveBeenCalledExactlyOnceWith(RUN);
  });

  it('brings the pop-out window forward from Show window', async () => {
    const popOut = vi.fn(() => Promise.resolve());
    overrides.browserPopOut = popOut;
    showState(run([tab()], { poppedOut: true }));
    await render(
      <BrowserPane
        runId={RUN}
        visible
        onClose={() => undefined}
        chatTitle="Fix the build"
      />,
    );

    await act(async () => button('Show window').click());

    expect(popOut).toHaveBeenCalledExactlyOnceWith(RUN, 'Fix the build');
  });

  it('places the page in the chat window while popped out, with no close button', async () => {
    showState(run([tab()], { poppedOut: true }));
    await render(<BrowserPane runId={RUN} visible windowed />);

    expect(setBounds).toHaveBeenCalledWith(RUN, {
      x: PLACEHOLDER.left,
      y: PLACEHOLDER.top,
      width: PLACEHOLDER.width,
      height: PLACEHOLDER.height,
    });
    expect(container.textContent).not.toContain('Open in its own window');
    expect(
      container.querySelector('button[aria-label="Close browser"]'),
    ).toBeNull();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it('docks back from Expand in the chat window', async () => {
    const dock = vi.fn(() => Promise.resolve());
    overrides.browserDock = dock;
    showState(run([tab()], { poppedOut: true }));
    await render(<BrowserPane runId={RUN} visible windowed />);

    await act(async () => button('Expand').click());
    await act(async () => option('Dock back')!.click());

    expect(dock).toHaveBeenCalledExactlyOnceWith(RUN);
  });

  it('asks for a sign-in in the pane while the tabs are popped out', async () => {
    showState(
      run(
        [tab({ authRequest: { host: 'staging.acme.dev', realm: 'Staging' } })],
        { poppedOut: true },
      ),
    );
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Open in its own window');
  });

  it('keeps the tabs and history buttons working while popped out', async () => {
    const history = vi.fn(() => Promise.resolve());
    overrides.browserHistory = history;
    showState(run([tab({ canGoBack: true })], { poppedOut: true }));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    await act(async () => button('Back').click());

    expect(history).toHaveBeenCalledExactlyOnceWith(RUN, 't1', 'back');
  });

  it('lists the recent addresses on a tab with no address', async () => {
    const navigate = vi.fn(() => Promise.resolve());
    overrides.browserNavigate = navigate;
    showState(
      run([tab({ url: '', title: '' })], { recent: ['https://a.test/x'] }),
    );
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    await act(async () => button('https://a.test/x').click());

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      RUN,
      't1',
      'https://a.test/x',
    );
  });
});

describe('the chat grid and the pane it hosts', () => {
  function emit(event: BrowserStateEvent): void {
    act(() => {
      for (const listener of listeners) {
        listener(event);
      }
    });
  }

  const grid = (): React.ReactElement => (
    <ThreadUiMemoryContext.Provider value={RUN}>
      <BrowserGrid runId={RUN}>
        <BrowserToggleButton runId={RUN} />
        <BrowserColumn narrow={false} chatTitle="Chat" />
      </BrowserGrid>
    </ThreadUiMemoryContext.Provider>
  );
  const paneShown = (): boolean =>
    container.querySelector('[data-slot="browser-pane"]') !== null;

  it("opens the pane only for an agent's new tab", async () => {
    await render(grid());
    expect(paneShown()).toBe(false);

    emit({ state: run([tab()]), agentOpenedTabId: null, dockedBack: false });
    expect(paneShown()).toBe(false);

    emit({
      state: run([tab({ openedBy: 'Engineer' })]),
      agentOpenedTabId: 't1',
      dockedBack: false,
    });
    expect(paneShown()).toBe(true);

    await act(async () => button('Close browser').click());
    expect(paneShown()).toBe(false);

    emit({
      state: run([tab({ drivenBy: 'Engineer' })]),
      agentOpenedTabId: null,
      dockedBack: false,
    });
    expect(paneShown()).toBe(false);
  });

  it('marks an agent tab opened in another chat on its globe, not the open pane', async () => {
    await render(grid());
    emit({
      state: { ...run([tab()]), runId: 'run-2' },
      agentOpenedTabId: 't1',
      dockedBack: false,
    });
    expect(paneShown()).toBe(false);

    await render(
      <ThreadUiMemoryContext.Provider value="run-2">
        <BrowserToggleButton runId="run-2" />
      </ThreadUiMemoryContext.Provider>,
    );
    expect(
      container.querySelector('[data-slot="browser-unseen-dot"]'),
    ).not.toBeNull();
  });

  it('reopens the column closed during the pop-out once the browser docks back', async () => {
    await render(grid());
    emit({
      state: run([tab()], { poppedOut: true }),
      agentOpenedTabId: null,
      dockedBack: false,
    });
    expect(paneShown()).toBe(false);

    emit({ state: run([tab()]), agentOpenedTabId: null, dockedBack: true });

    expect(paneShown()).toBe(true);
  });

  it('opens the column of a chat not on screen when its browser docks back', async () => {
    await render(grid());

    emit({
      state: { ...run([tab()]), runId: 'run-2' },
      agentOpenedTabId: null,
      dockedBack: true,
    });

    expect(paneShown()).toBe(false);
    expect(readThreadFlag('run-2', BROWSER_PANE_OPEN_KEY)).toBe(true);
  });

  it('keeps the browser column between its neighbours, zero wide while closed', async () => {
    await render(
      <ThreadUiMemoryContext.Provider value={RUN}>
        <div>
          <section data-slot="transcript-stand-in" />
          <BrowserColumn narrow={false} chatTitle="Chat" />
          <aside data-slot="agents-stand-in" />
        </div>
      </ThreadUiMemoryContext.Provider>,
    );
    const column = container.querySelector<HTMLElement>(
      '[data-slot="browser-column"]',
    );
    expect(column?.previousElementSibling?.getAttribute('data-slot')).toBe(
      'transcript-stand-in',
    );
    expect(column?.nextElementSibling?.getAttribute('data-slot')).toBe(
      'agents-stand-in',
    );
    expect(column?.style.width).toBe('0px');
  });
});

function option(label: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

describe('BrowserPane — closing a tab', () => {
  const twoTabs = (): BrowserRunState =>
    run([tab(), tab({ id: 't2', title: 'Second', url: 'https://b.test/' })]);

  it('draws a close button on every tab and closes that tab', async () => {
    const close = vi.fn(() => Promise.resolve());
    overrides.browserCloseTab = close;
    showState(twoTabs());
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    expect(
      container.querySelectorAll('[role="tablist"] [data-slot="tab-close"]'),
    ).toHaveLength(2);

    await act(async () => button('Close Second').click());

    expect(close).toHaveBeenCalledExactlyOnceWith(RUN, 't2');
  });

  it('closes the focused tab on Delete', async () => {
    const close = vi.fn(() => Promise.resolve());
    overrides.browserCloseTab = close;
    showState(twoTabs());
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    const selected = container.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    )!;
    await act(async () => {
      selected.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      );
    });

    expect(close).toHaveBeenCalledExactlyOnceWith(RUN, 't1');
  });
});

describe('BrowserPane — the expand and page menus', () => {
  it('offers a new window and full screen from Expand, not the page tools', async () => {
    const popOut = vi.fn(() => Promise.resolve());
    overrides.browserPopOut = popOut;
    showState(run([tab()]));
    const onFullScreen = vi.fn();
    await render(
      <BrowserPane
        runId={RUN}
        visible
        onClose={() => undefined}
        chatTitle="My chat"
        onFullScreen={onFullScreen}
      />,
    );

    await act(async () => button('Expand').click());
    expect(option('Open DevTools')).toBeUndefined();
    expect(option('Open full screen')).toBeDefined();

    await act(async () => option('Open in new window')!.click());
    expect(popOut).toHaveBeenCalledExactlyOnceWith(RUN, 'My chat');

    await act(async () => button('Expand').click());
    await act(async () => option('Open full screen')!.click());
    expect(onFullScreen).toHaveBeenLastCalledWith(true);
  });

  it('keeps the page tools in the page menu beside the address', async () => {
    const tabAction = vi.fn(() => Promise.resolve());
    overrides.browserTabAction = tabAction;
    showState(run([tab()]));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    await act(async () => button('Page menu').click());
    expect(option('Open in new window')).toBeUndefined();
    await act(async () => option('Open DevTools')!.click());

    expect(tabAction).toHaveBeenCalledExactlyOnceWith(RUN, 't1', 'devtools');
  });

  it('offers no full screen where the host gives none', async () => {
    showState(run([tab()]));
    await render(<BrowserPane runId={RUN} visible onClose={() => undefined} />);

    await act(async () => button('Expand').click());

    expect(option('Open in new window')).toBeDefined();
    expect(option('Open full screen')).toBeUndefined();
  });
});

describe('BrowserColumn — full screen', () => {
  const column = (): React.ReactElement => (
    <ThreadUiMemoryContext.Provider value={RUN}>
      <BrowserGrid runId={RUN}>
        <BrowserColumn narrow={false} chatTitle="Chat" />
      </BrowserGrid>
    </ThreadUiMemoryContext.Provider>
  );

  async function openPane(): Promise<void> {
    await render(column());
    act(() => {
      for (const listener of listeners) {
        listener({
          state: run([tab()]),
          agentOpenedTabId: 't1',
          dockedBack: false,
        });
      }
    });
  }

  it('moves the live page into a full-screen dialog and back', async () => {
    await openPane();

    await act(async () => button('Expand').click());
    setBounds.mockClear();
    capture.mockClear();
    await act(async () => option('Open full screen')!.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(
      dialog?.querySelector('[data-slot="browser-full-screen"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-slot="browser-pane"]'),
    ).toHaveLength(1);
    expect(capture).not.toHaveBeenCalled();
    expect(setBounds).toHaveBeenLastCalledWith(RUN, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(
      dialog?.querySelector('button[aria-label="Close browser"]'),
    ).toBeNull();

    await act(async () => button('Close').click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="browser-pane"]'),
    ).not.toBeNull();
  });

  it('still hides the page behind a menu opened over the full-screen view', async () => {
    await openPane();
    await act(async () => button('Expand').click());
    await act(async () => option('Open full screen')!.click());
    capture.mockClear();

    await act(async () => button('Page menu').click());

    expect(capture).toHaveBeenCalledWith(RUN);
  });
});
