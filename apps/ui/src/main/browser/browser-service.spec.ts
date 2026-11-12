import type { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../shared/contracts';
import { AgentOp } from './browser-agent-op';

interface FakeContents extends EventEmitter {
  url: string;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null;
}

interface FakeView {
  options: { webPreferences: { partition: string } };
  webContents: FakeContents;
  setBounds: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
}

interface FakeWindow extends EventEmitter {
  contentView: {
    addChildView: ReturnType<typeof vi.fn>;
    removeChildView: ReturnType<typeof vi.fn>;
  };
  webContents: { send: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
}

interface FakeSession {
  partition: string;
  clearStorageData: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  seq: 0,
  views: [] as FakeView[],
  windows: [] as FakeWindow[],
  sessions: new Map<string, FakeSession>(),
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  configure: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Contents extends Emitter {
    id = ++h.seq;
    url = '';
    destroyed = false;
    windowOpenHandler:
      ((details: { url: string }) => { action: string }) | null = null;
    loadURL = vi.fn((url: string) => {
      this.url = url;
      return Promise.resolve();
    });
    close = vi.fn(() => {
      this.destroyed = true;
    });
    isDestroyed = (): boolean => this.destroyed;
    getURL = (): string => this.url;
    getTitle = (): string => '';
    isLoading = (): boolean => false;
    stop = vi.fn();
    reload = vi.fn();
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    setWindowOpenHandler = (
      handler: (details: { url: string }) => { action: string },
    ): void => {
      this.windowOpenHandler = handler;
    };
  }
  class View {
    webContents = new Contents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(public options: { webPreferences: { partition: string } }) {
      h.views.push(this as unknown as FakeView);
    }
  }
  class Window extends Emitter {
    static getAllWindows = (): Window[] => h.windows as unknown as Window[];
    destroyed = false;
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    webContents = { send: vi.fn() };
    isDestroyed = (): boolean => this.destroyed;
    getContentBounds = () => ({ x: 0, y: 0, width: 900, height: 600 });
    focus = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    close = vi.fn(() => {
      this.emit('close');
      this.destroyed = true;
    });
    constructor() {
      super();
      h.windows.push(this as unknown as FakeWindow);
    }
  }
  return {
    app: {
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
        h.appListeners.set(name, listener);
      }),
      removeListener: vi.fn(),
    },
    BrowserWindow: Window,
    WebContentsView: View,
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: {
      fromPartition: (partition: string) => {
        let fake = h.sessions.get(partition);
        if (fake === undefined) {
          fake = {
            partition,
            clearStorageData: vi.fn(() => Promise.resolve()),
          };
          h.sessions.set(partition, fake);
        }
        return fake;
      },
    },
  };
});

vi.mock('./browser-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browser-sessions')>()),
  configureBrowserSession: h.configure,
}));

import { BrowserWindow } from 'electron';

import { BrowserService, resolveAddress } from './browser-service';

const newWindow = (): FakeWindow =>
  new (BrowserWindow as unknown as new () => FakeWindow)();

const asWindow = (win: FakeWindow): BrowserWindow =>
  win as unknown as BrowserWindow;

function makeService(): {
  service: BrowserService;
  main: FakeWindow;
  createPopout: ReturnType<typeof vi.fn>;
} {
  const main = newWindow();
  const createPopout = vi.fn(() => asWindow(newWindow()));
  const service = new BrowserService({
    proxyPort: 4000,
    ready: Promise.resolve(),
    mainWindow: () => asWindow(main),
    createPopout,
  });
  return { service, main, createPopout };
}

const DOCKED = { x: 10, y: 20, width: 300, height: 200 };
const WINDOWED = { x: 0, y: 92, width: 1100, height: 640 };

const stateEvents = (main: FakeWindow): { agentOpenedTabId: string | null }[] =>
  main.webContents.send.mock.calls
    .filter(([channel]) => channel === IPC.onBrowserState)
    .map(([, event]) => event as { agentOpenedTabId: string | null });

beforeEach(() => {
  h.views.length = 0;
  h.windows.length = 0;
  h.sessions.clear();
  h.appListeners.clear();
  h.configure.mockReset();
  h.configure.mockImplementation(() => Promise.resolve());
});

describe('BrowserService', () => {
  it('opens window.open targets as a tab in the same session', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });

    const outcome = h.views[0]?.webContents.windowOpenHandler?.({
      url: 'https://popup.test/',
    });

    expect(outcome).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(h.views).toHaveLength(2));
    expect(h.views[1]?.options.webPreferences.partition).toBe(
      h.views[0]?.options.webPreferences.partition,
    );
    expect(service.state('run-1').tabs.map((tab) => tab.id)).toEqual([
      't1',
      't2',
    ]);
    expect(h.sessions.size).toBe(1);
  });

  it('moves the view into the pop-out over its own pane, without loadURL', async () => {
    const { service, main, createPopout } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    const view = h.views[0] as FakeView;
    expect(main.contentView.addChildView).toHaveBeenCalledWith(view);

    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;

    expect(createPopout).toHaveBeenCalledWith('run-1', 'Fix the build');
    expect(main.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(popout.contentView.addChildView).not.toHaveBeenCalled();
    expect(service.state('run-1').poppedOut).toBe(true);

    service.setBounds('run-1', WINDOWED, asWindow(popout));

    expect(popout.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith(WINDOWED);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
  });

  it('places the view only by the bounds of the window that holds it', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;
    service.setBounds('run-1', WINDOWED, asWindow(popout));
    const view = h.views[0] as FakeView;

    service.setBounds('run-1', DOCKED, asWindow(main));
    service.setBounds('run-1', { x: 1, y: 1, width: 5, height: 5 }, null);
    service.setBounds(
      'run-1',
      { x: 2, y: 2, width: 6, height: 6 },
      asWindow(newWindow()),
    );

    expect(view.setBounds).toHaveBeenLastCalledWith(WINDOWED);
    expect(main.contentView.addChildView).not.toHaveBeenCalled();
  });

  it('docks back once the docked pane measures again after the pop-out closes', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    await service.openTab('run-1', 'https://other.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    service.popOut('run-1', 'Fix the build');
    service.setBounds('run-1', null, asWindow(main));
    const popout = h.windows[1] as FakeWindow;
    service.setBounds('run-1', WINDOWED, asWindow(popout));
    service.selectTab('run-1', 't1');
    const first = h.views[0] as FakeView;

    popout.emit('close');

    expect(service.state('run-1')).toMatchObject({
      poppedOut: false,
      activeTabId: 't1',
    });
    expect(popout.contentView.removeChildView).toHaveBeenLastCalledWith(first);
    main.contentView.addChildView.mockClear();

    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(main.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(
      first,
    );
    expect(first.setBounds).toHaveBeenLastCalledWith(DOCKED);
    expect(service.state('run-1').tabs.map((tab) => tab.id)).toEqual([
      't1',
      't2',
    ]);
  });

  it('takes the page out of the pop-out while it reports no room for it', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;
    service.setBounds('run-1', WINDOWED, asWindow(popout));
    const view = h.views[0] as FakeView;

    service.setBounds('run-1', null, asWindow(popout));

    expect(popout.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(main.contentView.addChildView).not.toHaveBeenCalled();
  });

  it('sends state to the pop-out window as well as the main window', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;
    main.webContents.send.mockClear();
    popout.webContents.send.mockClear();

    await service.openTab('run-1', 'https://other.test/', { openedBy: null });

    expect(stateEvents(popout).length).toBeGreaterThan(0);
    expect(stateEvents(main).length).toBe(stateEvents(popout).length);
  });

  it('focuses the open pop-out instead of making a second one', async () => {
    const { service, createPopout } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow & {
      focus: ReturnType<typeof vi.fn>;
    };

    service.popOut('run-1', 'Fix the build');

    expect(createPopout).toHaveBeenCalledTimes(1);
    expect(popout.focus).toHaveBeenCalled();
  });

  it('opens each own-cookie tab on an in-memory session of its own', async () => {
    const { service } = makeService();
    await service.openTab('run-1', null, { openedBy: 'Agent' });
    await service.openTab('run-1', null, {
      openedBy: 'Agent',
      ownCookiesLabel: 'anna',
    });
    await service.openTab('run-1', null, {
      openedBy: 'Agent',
      ownCookiesLabel: 'boris',
    });

    const partitions = h.views.map(
      (view) => view.options.webPreferences.partition,
    );
    expect(partitions[0]).toBe('persist:geniro-browser-run-1');
    expect(partitions[1]).toMatch(/^geniro-browser-own-/);
    expect(partitions[2]).toMatch(/^geniro-browser-own-/);
    expect(partitions[1]).not.toBe(partitions[2]);
    expect(
      service.state('run-1').tabs.map((tab) => tab.ownCookiesLabel),
    ).toEqual([null, 'anna', 'boris']);
  });

  it("puts an own-cookie tab's cookies in before its first load", async () => {
    const { service } = makeService();
    const order: string[] = [];
    await service.openTab('run-1', 'https://stand.test/', {
      openedBy: 'Agent',
      ownCookiesLabel: 'anna',
      beforeLoad: () => {
        order.push(
          `cookies, loads so far: ${h.views[0]?.webContents.loadURL.mock.calls.length}`,
        );
        return Promise.resolve();
      },
    });

    expect(order).toEqual(['cookies, loads so far: 0']);
    expect(h.views[0]?.webContents.loadURL).toHaveBeenCalledWith(
      'https://stand.test/',
    );
  });

  it('closes the tab and loads nothing when its cookies cannot be put in', async () => {
    const { service } = makeService();

    await expect(
      service.openTab('run-1', 'https://stand.test/', {
        openedBy: 'Agent',
        ownCookiesLabel: 'anna',
        beforeLoad: () => Promise.reject(new Error('bad cookie')),
      }),
    ).rejects.toThrow('bad cookie');

    expect(h.views[0]?.webContents.loadURL).not.toHaveBeenCalled();
    expect(service.state('run-1').tabs).toEqual([]);
  });

  it('opens no view for a chat forgotten while its tab was being made', async () => {
    const waiting: (() => void)[] = [];
    const release = (): void => waiting.splice(0).forEach((done) => done());
    h.configure.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
        }),
    );
    const { service } = makeService();
    const opened = service.openTab('run-1', 'https://stand.test/', {
      openedBy: 'Agent',
    });
    await vi.waitFor(() => expect(h.configure).toHaveBeenCalledTimes(1));

    const forgotten = service.forgetRun('run-1');
    await vi.waitFor(() => expect(h.configure).toHaveBeenCalledTimes(2));
    release();
    await forgotten;

    await expect(opened).rejects.toThrow('closed');
    expect(h.views).toHaveLength(0);
  });

  it('hands only a web address to the system browser', async () => {
    const { shell } = await import('electron');
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents;

    await service.tabAction('run-1', 't1', 'openExternal');
    contents.url = 'file:///etc/passwd';
    await service.tabAction('run-1', 't1', 'openExternal');

    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://stand.test/');
  });

  it('refuses a sign-in prompt during an agent operation and parks it for the user otherwise', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents;
    const tab = service.getTab('run-1', 't1')!;
    const auth = { host: 'stand.test', realm: 'stand' };

    const op = new AgentOp({ memberName: 'Agent', allowedHosts: null });
    service.attachAgentOp(tab, op);
    const agentCallback = vi.fn();
    contents.emit(
      'login',
      { preventDefault: vi.fn() },
      {},
      auth,
      agentCallback,
    );
    op.end();

    expect(agentCallback).toHaveBeenCalledWith();
    expect(op.authBlocked).toBe(true);
    expect(service.state('run-1').tabs[0]?.authRequest).toBeNull();

    const userCallback = vi.fn();
    contents.emit('login', { preventDefault: vi.fn() }, {}, auth, userCallback);

    expect(userCallback).not.toHaveBeenCalled();
    expect(service.state('run-1').tabs[0]?.authRequest).toEqual(auth);
  });

  it('makes no session to forget a chat that never had a browser', async () => {
    const { service } = makeService();

    await service.forgetRun('run-untouched');

    expect(h.sessions.size).toBe(0);
    expect(h.configure).not.toHaveBeenCalled();
  });

  it('forgets a run: closes tabs and clears its jar', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents;

    await service.forgetRun('run-1');

    expect(contents.close).toHaveBeenCalledTimes(1);
    expect(service.state('run-1').tabs).toEqual([]);
    expect(
      h.sessions.get('persist:geniro-browser-run-1')?.clearStorageData,
    ).toHaveBeenCalledTimes(1);
  });

  it('awaits configureBrowserSession before the first load', async () => {
    let release: () => void = () => undefined;
    h.configure.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { service } = makeService();

    const opened = service.openTab('run-1', 'https://stand.test/', {
      openedBy: null,
    });
    await vi.waitFor(() => expect(h.configure).toHaveBeenCalledTimes(1));
    expect(h.views).toHaveLength(0);

    release();
    await opened;

    expect(h.configure).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 'persist:geniro-browser-run-1' }),
      4000,
    );
    expect(h.views[0]?.webContents.loadURL).toHaveBeenCalledWith(
      'https://stand.test/',
    );
  });

  it('emits agentOpenedTabId only for an agent-opened tab', async () => {
    const { service, main } = makeService();

    await service.openTab('run-1', 'https://one.test/', { openedBy: null });
    await service.openTab('run-1', 'https://two.test/', { openedBy: 'Dev' });
    h.views[1]?.webContents.emit('did-stop-loading');

    const opened = stateEvents(main)
      .map((event) => event.agentOpenedTabId)
      .filter((id) => id !== null);
    expect(opened).toEqual(['t2']);
  });

  it('cancels a redirect to an unapproved host only while an agent operation runs', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    const tab = service.getTab('run-1', 't1');
    const contents = h.views[0]?.webContents as FakeContents;
    const redirect = (): { preventDefault: ReturnType<typeof vi.fn> } => {
      const event = {
        url: 'https://evil.test/',
        isMainFrame: true,
        preventDefault: vi.fn(),
      };
      contents.emit('will-redirect', event);
      return event;
    };

    expect(redirect().preventDefault).not.toHaveBeenCalled();

    const op = new AgentOp({ memberName: 'Dev', allowedHosts: ['stand.test'] });
    service.attachAgentOp(tab as NonNullable<typeof tab>, op);

    expect(redirect().preventDefault).toHaveBeenCalledTimes(1);
    expect(op.blockedHost).toBe('evil.test');
  });

  it('cancels a top-frame navigation to a scheme other than http(s)', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    const event = {
      url: 'file:///etc/passwd',
      isMainFrame: true,
      preventDefault: vi.fn(),
    };

    h.views[0]?.webContents.emit('will-navigate', event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('trusts a certificate error only for a host the user continued past', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://self-signed.test/', {
      openedBy: null,
    });
    const view = h.views[0] as FakeView;
    const onError = h.appListeners.get('certificate-error') as (
      ...args: unknown[]
    ) => void;
    const ask = (): ReturnType<typeof vi.fn> => {
      const callback = vi.fn();
      onError(
        { preventDefault: vi.fn() },
        view.webContents,
        'https://self-signed.test/',
        'net::ERR_CERT_AUTHORITY_INVALID',
        {},
        callback,
      );
      return callback;
    };

    expect(ask()).toHaveBeenCalledWith(false);
    expect(service.state('run-1').tabs[0]?.error?.certificate).toBe(true);

    service.continueInsecure('run-1', 't1');

    expect(ask()).toHaveBeenCalledWith(true);
  });

  it('closes a tab and selects its neighbour', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://one.test/', { openedBy: null });
    await service.openTab('run-1', 'https://two.test/', { openedBy: null });

    await service.closeTab('run-1', 't2');

    expect(service.state('run-1').activeTabId).toBe('t1');
    expect(h.views[1]?.webContents.close).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAddress', () => {
  it.each([
    ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['http://stand.test:3000', 'http://stand.test:3000'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/health', 'http://127.0.0.1:8080/health'],
    ['pr-4.localhost', 'http://pr-4.localhost'],
    ['stand.local:5173', 'http://stand.local:5173'],
    ['example.com/docs', 'https://example.com/docs'],
    [
      'how to center a div',
      'https://duckduckgo.com/?q=how%20to%20center%20a%20div',
    ],
    [
      'file:///etc/passwd',
      'https://duckduckgo.com/?q=file%3A%2F%2F%2Fetc%2Fpasswd',
    ],
  ])('reads %s as %s', (typed, expected) => {
    expect(resolveAddress(typed)).toBe(expected);
  });

  it('reads blank input as nothing to load', () => {
    expect(resolveAddress('   ')).toBeNull();
  });
});
