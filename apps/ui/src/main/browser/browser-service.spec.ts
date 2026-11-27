import type { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BrowserStateEvent, IPC } from '../../shared/contracts';
import { AgentOp } from './browser-agent-op';
import type * as browserSessionsModule from './browser-sessions';
import { PROXY_CONNECT_FAILED } from './egress-proxy';

interface FakeContents extends EventEmitter {
  url: string;
  focused: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null;
}

interface FakeView {
  options: { webPreferences: { partition: string } };
  webContents: FakeContents;
  setBounds: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
}

interface FakeWindow extends EventEmitter {
  destroyed: boolean;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  contentView: {
    addChildView: ReturnType<typeof vi.fn>;
    removeChildView: ReturnType<typeof vi.fn>;
  };
  webContents: { send: ReturnType<typeof vi.fn>; focused: boolean };
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
  menus: [] as {
    template: { label?: string; role?: string; click?: () => void }[];
    popup: ReturnType<typeof vi.fn>;
  }[],
  configure: vi.fn((): Promise<void> => Promise.resolve()),
  showMessageBoxSync: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Contents extends Emitter {
    id = ++h.seq;
    url = '';
    destroyed = false;
    focused = false;
    focus = vi.fn(() => {
      this.focused = true;
    });
    isFocused = (): boolean => this.focused;
    cut = vi.fn();
    copy = vi.fn();
    paste = vi.fn();
    selectAll = vi.fn();
    copyImageAt = vi.fn();
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
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    setBounds = vi.fn((bounds: View['bounds']) => {
      this.bounds = bounds;
    });
    getBounds = (): View['bounds'] => this.bounds;
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(public options: { webPreferences: { partition: string } }) {
      h.views.push(this);
    }
  }
  class Window extends Emitter {
    static getAllWindows = (): Window[] => h.windows as unknown as Window[];
    destroyed = false;
    focused = true;
    visible = true;
    minimized = false;
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    webContents = {
      send: vi.fn(),
      focused: false,
      isFocused(): boolean {
        return this.focused;
      },
    };
    isDestroyed = (): boolean => this.destroyed;
    isFocused = (): boolean => this.focused;
    isVisible = (): boolean => this.visible;
    isMinimized = (): boolean => this.minimized;
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
      h.windows.push(this);
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
    dialog: { showMessageBoxSync: h.showMessageBoxSync },
    Menu: {
      buildFromTemplate: (template: (typeof h.menus)[number]['template']) => {
        const menu = { template, popup: vi.fn() };
        h.menus.push(menu);
        return menu;
      },
    },
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
  ...(await importOriginal<typeof browserSessionsModule>()),
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

const stateEvents = (main: FakeWindow): BrowserStateEvent[] =>
  main.webContents.send.mock.calls
    .filter(([channel]) => channel === IPC.onBrowserState)
    .map(([, event]) => event as BrowserStateEvent);

beforeEach(() => {
  h.views.length = 0;
  h.windows.length = 0;
  h.sessions.clear();
  h.appListeners.clear();
  h.menus.length = 0;
  h.configure.mockReset();
  h.configure.mockImplementation(() => Promise.resolve());
  h.showMessageBoxSync.mockReset();
});

describe('BrowserService', () => {
  it('gives a tab opened while the pane is closed the window size, so its page paints and can be captured', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: 'Dev' });
    const view = h.views[0] as FakeView;

    expect(main.contentView.addChildView).not.toHaveBeenCalled();
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 900,
      height: 600,
    });
  });

  it('gives a tab opened while its chat is off screen the size of the pane its other tabs were shown in', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://a.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    service.setBounds('run-1', null, asWindow(main));
    await service.openTab('run-1', 'https://b.test/', { openedBy: 'Dev' });
    const second = h.views[1] as FakeView;

    expect(main.contentView.addChildView).not.toHaveBeenCalledWith(second);
    expect(second.setBounds).toHaveBeenLastCalledWith(DOCKED);
  });

  it('resizes a background tab with the pane from its first measure on, so its page matches the area the user would see it in', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://a.test/', { openedBy: 'Dev' });
    await service.openTab('run-1', 'https://b.test/', { openedBy: 'Dev' });
    const background = h.views[0] as FakeView;

    service.setBounds('run-1', DOCKED, asWindow(main));
    expect(background.setBounds).toHaveBeenLastCalledWith(DOCKED);

    const narrower = { ...DOCKED, x: DOCKED.x + 16, width: DOCKED.width - 16 };
    service.setBounds('run-1', narrower, asWindow(main));

    expect(main.contentView.addChildView).not.toHaveBeenCalledWith(background);
    expect(background.setBounds).toHaveBeenLastCalledWith(narrower);
  });

  it("sizes a background tab by the pop-out's pane while the chat is popped out", async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://a.test/', { openedBy: null });
    await service.openTab('run-1', 'https://b.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;

    service.setBounds('run-1', WINDOWED, asWindow(popout));
    const narrower = { ...WINDOWED, width: WINDOWED.width - 16 };
    service.setBounds('run-1', narrower, asWindow(popout));
    service.setBounds('run-1', { ...DOCKED, width: 250 }, asWindow(main));

    expect((h.views[0] as FakeView).setBounds).toHaveBeenLastCalledWith(
      narrower,
    );
  });

  it('leaves a background tab at its last size while no pane is measured', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://a.test/', { openedBy: 'Dev' });
    await service.openTab('run-1', 'https://b.test/', { openedBy: 'Dev' });
    service.setBounds('run-1', DOCKED, asWindow(main));
    const background = h.views[0] as FakeView;
    const calls = background.setBounds.mock.calls.length;

    service.setBounds('run-1', null, asWindow(main));

    expect(background.setBounds).toHaveBeenCalledTimes(calls);
    expect(background.setBounds).toHaveBeenLastCalledWith(DOCKED);
  });

  it('leaves a tab without a size when no window is left to read one from', async () => {
    const { service, main } = makeService();
    main.destroyed = true;

    await service.openTab('run-1', 'https://stand.test/', { openedBy: 'Dev' });

    expect((h.views[0] as FakeView).setBounds).not.toHaveBeenCalled();
  });

  it('keeps an agent-driven tab on a window that paints', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    const tab = service.getTab('run-1', 't1');

    service.attachAgentOp(
      tab as NonNullable<typeof tab>,
      new AgentOp({ memberName: 'Dev', allowedHosts: null }),
    );

    expect(main.contentView.removeChildView).not.toHaveBeenCalled();
  });

  it('leaves the tab on a hidden window while no agent drives it', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    const tab = service.getTab('run-1', 't1');
    const op = new AgentOp({ memberName: 'Dev', allowedHosts: null });
    service.attachAgentOp(tab as NonNullable<typeof tab>, op);
    op.end();

    main.visible = false;
    main.emit('hide');

    expect(main.contentView.removeChildView).not.toHaveBeenCalled();
  });

  it.each([
    [
      'hidden',
      'hide',
      'show',
      (win: FakeWindow, painting: boolean) => (win.visible = painting),
    ],
    [
      'minimized',
      'minimize',
      'restore',
      (win: FakeWindow, painting: boolean) => (win.minimized = !painting),
    ],
  ])(
    'takes an agent-driven tab off its window when the window is %s mid-operation, and back when it returns',
    async (_state, leaveEvent, returnEvent, paint) => {
      const { service, main } = makeService();
      await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
      service.setBounds('run-1', DOCKED, asWindow(main));
      const view = h.views[0] as FakeView;
      const tab = service.getTab('run-1', 't1');
      service.attachAgentOp(
        tab as NonNullable<typeof tab>,
        new AgentOp({ memberName: 'Dev', allowedHosts: null }),
      );

      paint(main, false);
      main.emit(leaveEvent);
      expect(main.contentView.removeChildView).toHaveBeenLastCalledWith(view);

      main.contentView.addChildView.mockClear();
      paint(main, true);
      main.emit(returnEvent);
      expect(main.contentView.addChildView).toHaveBeenCalledWith(view);
    },
  );

  it.each([
    ['hidden', (win: FakeWindow) => (win.visible = false)],
    ['minimized', (win: FakeWindow) => (win.minimized = true)],
  ])(
    'takes an agent-driven tab off a %s window for the operation, where it cannot paint, and puts it back after',
    async (_state, leave) => {
      const { service, main } = makeService();
      await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
      service.setBounds('run-1', DOCKED, asWindow(main));
      const view = h.views[0] as FakeView;
      const tab = service.getTab('run-1', 't1');
      leave(main);
      const op = new AgentOp({ memberName: 'Dev', allowedHosts: null });

      service.attachAgentOp(tab as NonNullable<typeof tab>, op);

      expect(main.contentView.removeChildView).toHaveBeenLastCalledWith(view);
      main.contentView.addChildView.mockClear();
      op.end();
      expect(main.contentView.addChildView).toHaveBeenCalledWith(view);
    },
  );

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

  it('docks back when the pop-out window goes away without a close event', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;

    popout.emit('closed');

    expect(service.state('run-1').poppedOut).toBe(false);
  });

  it.each([
    ['the Dock back press', (service: BrowserService) => service.dock('run-1')],
    [
      'closing the window',
      (_service: BrowserService, popout: FakeWindow) => popout.emit('close'),
    ],
  ])(
    'marks exactly one state event as docked back on %s',
    async (_, dockBy) => {
      const { service, main } = makeService();
      await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
      service.popOut('run-1', 'Fix the build');
      const popout = h.windows[1] as FakeWindow;
      expect(stateEvents(main).some((event) => event.dockedBack)).toBe(false);
      main.webContents.send.mockClear();

      dockBy(service, popout);

      const docked = stateEvents(main).filter((event) => event.dockedBack);
      expect(docked).toHaveLength(1);
      expect(docked[0]?.state).toMatchObject({
        runId: 'run-1',
        poppedOut: false,
      });
    },
  );

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

  it('opens a tab under the name and colour it was given', async () => {
    const { service } = makeService();
    await service.openTab('run-1', null, {
      openedBy: 'Agent',
      name: 'Staging login',
      color: 'teal',
    });

    expect(service.state('run-1').tabs[0]).toMatchObject({
      name: 'Staging login',
      color: 'teal',
    });
  });

  it("keeps the user's name and colour from an agent, field by field", async () => {
    const { service } = makeService();
    await service.openTab('run-1', null, { openedBy: 'Agent', name: 'Login' });

    service.labelTab('run-1', 't1', { name: '  Admin view ' }, 'user');
    const kept = service.labelTab(
      'run-1',
      't1',
      { name: 'Login again', color: 'green' },
      'agent',
    );

    expect(kept).toEqual(['name']);
    expect(service.state('run-1').tabs[0]).toMatchObject({
      name: 'Admin view',
      color: 'green',
    });

    service.labelTab('run-1', 't1', { color: null }, 'user');
    expect(service.labelTab('run-1', 't1', { color: 'red' }, 'agent')).toEqual([
      'color',
    ]);
    expect(service.state('run-1').tabs[0]?.color).toBeNull();
  });

  it("clears the user's empty rename back to the page title and still keeps it from agents", async () => {
    const { service } = makeService();
    await service.openTab('run-1', null, { openedBy: 'Agent', name: 'Login' });

    service.labelTab('run-1', 't1', { name: '   ' }, 'user');
    service.labelTab('run-1', 't1', { name: 'Login' }, 'agent');

    expect(service.state('run-1').tabs[0]?.name).toBeNull();
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

  it('reloads a tab and clears its error, from the toolbar and for an agent alike', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://one.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents & {
      reload: ReturnType<typeof vi.fn>;
    };
    const tab = service.getTab('run-1', 't1') as NonNullable<
      ReturnType<BrowserService['getTab']>
    >;
    const fail = (): void => {
      contents.emit(
        'did-fail-load',
        {},
        -105,
        'NAME_NOT_RESOLVED',
        'https://one.test/',
        true,
      );
    };

    fail();
    main.webContents.send.mockClear();
    service.history('run-1', 't1', 'reload');
    const fromToolbar = stateEvents(main).at(-1)?.state.tabs[0]?.error;
    fail();
    main.webContents.send.mockClear();
    service.reload(tab);
    const forAgent = stateEvents(main).at(-1)?.state.tabs[0]?.error;

    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(fromToolbar).toBeNull();
    expect(forAgent).toBeNull();
  });

  it('shows why a plain-http page the egress proxy could not reach did not load', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'http://127.0.0.1:59999/', {
      openedBy: null,
    });
    const contents = h.views[0]?.webContents as FakeContents;

    contents.emit(
      'did-navigate',
      {},
      'http://127.0.0.1:59999/',
      502,
      `${PROXY_CONNECT_FAILED}connect ECONNREFUSED 127.0.0.1:59999`,
    );
    contents.emit('did-finish-load', {});
    contents.emit('did-stop-loading', {});

    expect(service.state('run-1').tabs[0]?.error).toEqual({
      code: 502,
      description: 'connect ECONNREFUSED 127.0.0.1:59999',
      url: 'http://127.0.0.1:59999/',
      certificate: false,
    });
  });

  it.each([
    [502, 'Bad Gateway'],
    [500, 'Internal Server Error'],
    [404, 'Not Found'],
  ])("shows a site's own %i page as a page", async (status, reason) => {
    const { service } = makeService();
    await service.openTab('run-1', 'http://dev.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents;

    contents.emit('did-navigate', {}, 'http://dev.test/', status, reason);
    contents.emit('did-finish-load', {});

    expect(service.state('run-1').tabs[0]?.error).toBeNull();
  });

  it('clears an earlier proxy failure on the next commit', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'http://dev.test/', { openedBy: null });
    const contents = h.views[0]?.webContents as FakeContents;

    contents.emit(
      'did-navigate',
      {},
      'http://dev.test/',
      502,
      `${PROXY_CONNECT_FAILED}getaddrinfo ENOTFOUND dev.test`,
    );
    contents.emit('did-finish-load', {});
    const failed = service.state('run-1').tabs[0]?.error;
    contents.emit('did-navigate', {}, 'http://dev.test/', 200, 'OK');

    expect(failed?.description).toBe('getaddrinfo ENOTFOUND dev.test');
    expect(service.state('run-1').tabs[0]?.error).toBeNull();
  });

  it("keeps a failed load's error after Chromium's error page finishes loading", async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://127.0.0.1:59999/', {
      openedBy: null,
    });
    const contents = h.views[0]?.webContents as FakeContents;

    contents.emit(
      'did-fail-load',
      {},
      -111,
      'ERR_TUNNEL_CONNECTION_FAILED',
      'https://127.0.0.1:59999/',
      true,
    );
    contents.emit('did-finish-load', {});
    contents.emit('did-stop-loading', {});
    const afterErrorPage = service.state('run-1').tabs[0]?.error;
    contents.emit('did-navigate', {}, 'https://one.test/', 200, 'OK');

    expect(afterErrorPage).toEqual({
      code: -111,
      description: 'ERR_TUNNEL_CONNECTION_FAILED',
      url: 'https://127.0.0.1:59999/',
      certificate: false,
    });
    expect(service.state('run-1').tabs[0]?.error).toBeNull();
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

describe('BrowserService page that asks to stay', () => {
  const LEAVE = 'Leave page';
  const STAY = 'Stay';

  const leaveAttempt = (
    contents: FakeContents,
  ): { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn() };
    contents.emit('will-prevent-unload', event);
    return event;
  };

  const answer = (button: string): void => {
    h.showMessageBoxSync.mockImplementation((...args: unknown[]) => {
      const options = args.at(-1) as { buttons: string[] };
      const index = options.buttons.indexOf(button);
      if (index === -1) {
        throw new Error(`no ${button} button in ${options.buttons.join(', ')}`);
      }
      return index;
    });
  };

  const openDockedTab = async (): Promise<{
    service: BrowserService;
    main: FakeWindow;
    contents: FakeContents;
  }> => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'http://localhost:3020/', {
      openedBy: 'Peter Parker',
    });
    service.setBounds('run-1', DOCKED, asWindow(main));
    return { service, main, contents: h.views[0]?.webContents as FakeContents };
  };

  it('lets the page unload once the user chooses to leave, asking over its window', async () => {
    const { main, contents } = await openDockedTab();
    answer(LEAVE);

    const attempt = leaveAttempt(contents);

    expect(h.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(h.showMessageBoxSync.mock.calls[0]?.[0]).toBe(main);
    expect(attempt.preventDefault).toHaveBeenCalledOnce();
  });

  it('keeps the page when the user chooses to stay', async () => {
    const { contents } = await openDockedTab();
    answer(STAY);

    const attempt = leaveAttempt(contents);

    expect(h.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(attempt.preventDefault).not.toHaveBeenCalled();
  });

  it('asks without a parent window for a tab that is off screen', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'http://localhost:3020/', {
      openedBy: null,
    });
    answer(LEAVE);

    const attempt = leaveAttempt(h.views[0]?.webContents as FakeContents);

    expect(h.showMessageBoxSync.mock.calls[0]).toHaveLength(1);
    expect(attempt.preventDefault).toHaveBeenCalledOnce();
  });

  it('asks without a parent window once the window holding the tab is gone', async () => {
    const { main, contents } = await openDockedTab();
    (main as FakeWindow & { destroyed: boolean }).destroyed = true;
    answer(LEAVE);

    const attempt = leaveAttempt(contents);

    expect(h.showMessageBoxSync.mock.calls[0]).toHaveLength(1);
    expect(attempt.preventDefault).toHaveBeenCalledOnce();
  });

  it('stops asking while an agent operation drives the tab', async () => {
    const { service, contents } = await openDockedTab();
    answer(STAY);
    leaveAttempt(contents);
    expect(h.showMessageBoxSync).toHaveBeenCalledOnce();

    service.attachAgentOp(
      service.getTab('run-1', 't1') as NonNullable<
        ReturnType<BrowserService['getTab']>
      >,
      new AgentOp({ memberName: 'Dev', allowedHosts: null }),
    );
    answer(LEAVE);

    const attempt = leaveAttempt(contents);

    expect(h.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(attempt.preventDefault).not.toHaveBeenCalled();
  });

  const driveWithAgent = (
    service: BrowserService,
    leavesGuardedPage: boolean,
  ): AgentOp => {
    const op = new AgentOp({ memberName: 'Dev', allowedHosts: null });
    op.leavesGuardedPage = leavesGuardedPage;
    service.attachAgentOp(
      service.getTab('run-1', 't1') as NonNullable<
        ReturnType<BrowserService['getTab']>
      >,
      op,
    );
    return op;
  };

  it('lets the guard keep the page for an agent and tells its operation', async () => {
    const { service, contents } = await openDockedTab();
    const op = driveWithAgent(service, false);

    const attempt = leaveAttempt(contents);

    expect(attempt.preventDefault).not.toHaveBeenCalled();
    expect(op.unloadBlocked).toBe(true);
    expect(h.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('leaves the page for an agent operation that forces it, without asking', async () => {
    const { service, contents } = await openDockedTab();
    const op = driveWithAgent(service, true);

    const attempt = leaveAttempt(contents);

    expect(attempt.preventDefault).toHaveBeenCalledOnce();
    expect(op.unloadBlocked).toBe(false);
    expect(h.showMessageBoxSync).not.toHaveBeenCalled();
  });
});

describe('BrowserService tab context menu', () => {
  const rightClickOnField = {
    x: 40,
    y: 25,
    linkURL: '',
    pageURL: 'https://stand.test/',
    frame: { url: 'https://stand.test/' },
    mediaType: 'none',
    hasImageContents: false,
    isEditable: true,
    selectionText: '',
    editFlags: {
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    },
  };

  it('opens over the host window at the click, offset by where the tab sits', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));

    h.views[0]?.webContents.emit('context-menu', {}, rightClickOnField);

    expect(h.menus).toHaveLength(1);
    expect(h.menus[0]?.popup).toHaveBeenCalledWith({
      window: main,
      x: DOCKED.x + 40,
      y: DOCKED.y + 25,
    });
  });

  it("pastes into the tab's own page, never through a role", async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    const contents = h.views[0]?.webContents as FakeContents;

    contents.emit('context-menu', {}, rightClickOnField);
    const template = h.menus[0]?.template ?? [];
    template.find((item) => item.label === 'Paste')?.click?.();

    expect(template.some((item) => item.role !== undefined)).toBe(false);
    expect(contents.paste).toHaveBeenCalledTimes(1);
  });

  it('opens in the pop-out once the tab has moved there', async () => {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    service.popOut('run-1', 'Fix the build');
    const popout = h.windows[1] as FakeWindow;
    service.setBounds('run-1', WINDOWED, asWindow(popout));

    h.views[0]?.webContents.emit('context-menu', {}, rightClickOnField);

    expect(h.menus[0]?.popup).toHaveBeenCalledWith({
      window: popout,
      x: WINDOWED.x + 40,
      y: WINDOWED.y + 25,
    });
  });

  it('shows no menu for a tab that is off screen', async () => {
    const { service } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });

    h.views[0]?.webContents.emit('context-menu', {}, rightClickOnField);

    expect(h.menus).toHaveLength(0);
  });
});

describe('BrowserService tab keyboard focus', () => {
  async function shownTab(): Promise<{
    service: BrowserService;
    main: FakeWindow;
    contents: FakeContents;
  }> {
    const { service, main } = makeService();
    await service.openTab('run-1', 'https://stand.test/', { openedBy: null });
    service.setBounds('run-1', DOCKED, asWindow(main));
    return { service, main, contents: h.views[0]?.webContents as FakeContents };
  }

  it('gives the page the keyboard back when its view returns after an overlay', async () => {
    const { service, main, contents } = await shownTab();
    contents.focused = true;

    service.setBounds('run-1', null, asWindow(main));
    contents.focused = false;
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves the keyboard where the user moved it while the view was off', async () => {
    const { service, main, contents } = await shownTab();
    contents.focused = true;

    service.setBounds('run-1', null, asWindow(main));
    contents.focused = false;
    main.webContents.focused = true;
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).not.toHaveBeenCalled();
  });

  it('does not take the keyboard for a page that did not have it', async () => {
    const { service, main, contents } = await shownTab();

    service.setBounds('run-1', null, asWindow(main));
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).not.toHaveBeenCalled();
  });

  it('never activates a window the user has left', async () => {
    const { service, main, contents } = await shownTab();
    contents.focused = true;

    service.setBounds('run-1', null, asWindow(main));
    contents.focused = false;
    main.focused = false;
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).not.toHaveBeenCalled();
  });

  it('focuses the page when the user clicks its still, even though the click landed in the renderer', async () => {
    const { service, main, contents } = await shownTab();
    service.setBounds('run-1', null, asWindow(main));
    main.webContents.focused = true;

    service.focusActiveTab('run-1');
    expect(contents.focus).not.toHaveBeenCalled();
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses a page already on screen at once when asked', async () => {
    const { service, contents } = await shownTab();

    service.focusActiveTab('run-1');

    expect(contents.focus).toHaveBeenCalledTimes(1);
  });

  it('never activates a window the user has left when the page is asked for', async () => {
    const { service, main, contents } = await shownTab();
    main.focused = false;

    service.focusActiveTab('run-1');
    service.setBounds('run-1', null, asWindow(main));
    service.focusActiveTab('run-1');
    service.setBounds('run-1', DOCKED, asWindow(main));

    expect(contents.focus).not.toHaveBeenCalled();
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
