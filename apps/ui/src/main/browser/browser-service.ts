import { randomUUID } from 'node:crypto';

import {
  app,
  BrowserWindow,
  clipboard,
  type Session,
  session as electronSession,
  shell,
  WebContentsView,
} from 'electron';

import {
  type BrowserAuthRequest,
  type BrowserBounds,
  type BrowserHistoryAction,
  type BrowserRunState,
  type BrowserStateEvent,
  type BrowserTabAction,
  type BrowserTabError,
  type BrowserTabState,
  IPC,
} from '../../shared/contracts';
import { type AgentOp } from './browser-agent-op';
import {
  chatPartition,
  configureBrowserSession,
  ownCookiePartition,
} from './browser-sessions';

const RECENT_LIMIT = 20;
const POP_OUT_SIZE = { width: 1100, height: 760 };
const SEARCH_URL = 'https://duckduckgo.com/?q=';

export interface BrowserTab {
  readonly id: string;
  readonly runId: string;
  readonly view: WebContentsView;
  readonly session: Session;
  readonly partition: string;
  readonly ownCookiesLabel: string | null;
  readonly openedBy: string | null;
  /** Element refs of the last snapshot, bound to backend DOM node ids. */
  readonly refs: Map<string, number>;
  op: AgentOp | null;
  error: BrowserTabError | null;
  authRequest: BrowserAuthRequest | null;
  authCallback: ((username?: string, password?: string) => void) | null;
  loading: boolean;
  attachedTo: BrowserWindow | null;
}

interface ChatBrowser {
  readonly runId: string;
  readonly tabs: Map<string, BrowserTab>;
  activeTabId: string | null;
  poppedOut: boolean;
  popout: BrowserWindow | null;
  bounds: BrowserBounds | null;
  recent: string[];
  counter: number;
  /** Hosts the user opened in this chat themselves; an agent may read them unasked. */
  userHosts: Set<string>;
}

export interface BrowserServiceOptions {
  proxyPort: number;
  /** Resolves once the launch sweep of orphaned jars is done; no session is made before. */
  ready: Promise<void>;
  mainWindow: () => BrowserWindow | null;
  log?: (message: string) => void;
  /** Whether a chat's jar folder is on disk from an earlier launch. */
  hasJarOnDisk?: (runId: string) => boolean;
}

export interface OpenTabOptions {
  /** The agent or member opening the tab; null for the user. */
  openedBy?: string | null;
  ownCookiesLabel?: string;
  /** A page's popup: shares that tab's session. */
  sameSessionAs?: BrowserTab;
  agentOp?: AgentOp;
  /** Runs once the session is configured and before the first load. */
  beforeLoad?: (session: Session) => Promise<void>;
}

interface NavigationEvent {
  url: string;
  isMainFrame?: boolean;
  preventDefault(): void;
}

export function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]'
  );
}

/** What the address bar's text means: an address as is, or words to search. */
export function resolveAddress(input: string): string | null {
  const typed = input.trim();
  if (typed === '') {
    return null;
  }
  const search = `${SEARCH_URL}${encodeURIComponent(typed)}`;
  if (/^https?:\/\//i.test(typed)) {
    return isWebUrl(typed) ? typed : search;
  }
  if (/\s/.test(typed)) {
    return search;
  }
  const authority = typed.split(/[/?#]/, 1)[0] ?? typed;
  const hostname = authority.replace(/:\d{0,5}$/, '').toLowerCase();
  let candidate: string | null = null;
  if (isLocalHost(hostname) || /^[^\s/:]+:\d{1,5}$/.test(authority)) {
    candidate = `http://${typed}`;
  } else if (hostname.includes('.')) {
    candidate = `https://${typed}`;
  }
  return candidate !== null && isWebUrl(candidate) ? candidate : search;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export class BrowserService {
  private readonly chats = new Map<string, ChatBrowser>();
  private readonly popouts = new Set<BrowserWindow>();
  private readonly byContents = new WeakMap<object, BrowserTab>();
  private readonly insecureHosts = new WeakMap<Session, Set<string>>();
  private readonly onCertificateError: (
    event: { preventDefault(): void },
    contents: object,
    url: string,
    error: string,
    certificate: unknown,
    callback: (allow: boolean) => void,
  ) => void;

  constructor(private readonly options: BrowserServiceOptions) {
    this.onCertificateError = (
      event,
      contents,
      url,
      error,
      _cert,
      callback,
    ) => {
      const tab = this.byContents.get(contents);
      if (tab === undefined) {
        return;
      }
      event.preventDefault();
      const host = hostOf(url);
      if (host !== null && this.insecureHosts.get(tab.session)?.has(host)) {
        callback(true);
        return;
      }
      callback(false);
      tab.error = { code: -200, description: error, url, certificate: true };
      this.emitRun(tab.runId);
    };
    app.on('certificate-error', this.onCertificateError);
  }

  state(runId: string): BrowserRunState {
    const chat = this.chats.get(runId);
    if (chat === undefined) {
      return {
        runId,
        tabs: [],
        activeTabId: null,
        poppedOut: false,
        recent: [],
      };
    }
    return {
      runId,
      tabs: [...chat.tabs.values()].map((tab) => this.tabState(tab)),
      activeTabId: chat.activeTabId,
      poppedOut: chat.poppedOut,
      recent: [...chat.recent],
    };
  }

  getTab(runId: string, tabId: string): BrowserTab | undefined {
    return this.chats.get(runId)?.tabs.get(tabId);
  }

  listTabs(runId: string): BrowserTab[] {
    return [...(this.chats.get(runId)?.tabs.values() ?? [])];
  }

  activeTabId(runId: string): string | null {
    return this.chats.get(runId)?.activeTabId ?? null;
  }

  async chatSession(runId: string): Promise<Session> {
    await this.options.ready;
    const chatSession = electronSession.fromPartition(chatPartition(runId));
    await configureBrowserSession(chatSession, this.options.proxyPort);
    return chatSession;
  }

  async openTab(
    runId: string,
    url: string | null,
    options: OpenTabOptions = {},
  ): Promise<string> {
    const chat = this.chatOf(runId);
    chat.counter += 1;
    const id = `t${chat.counter}`;
    await this.options.ready;
    const parent = options.sameSessionAs;
    const ownCookiesLabel =
      parent?.ownCookiesLabel ?? options.ownCookiesLabel ?? null;
    const partition =
      parent?.partition ??
      (options.ownCookiesLabel === undefined
        ? chatPartition(runId)
        : ownCookiePartition(randomUUID()));
    const tabSession = electronSession.fromPartition(partition);
    await configureBrowserSession(tabSession, this.options.proxyPort);
    if (this.chats.get(runId) !== chat) {
      throw new Error('The chat was closed before its tab opened');
    }
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab: BrowserTab = {
      id,
      runId,
      view,
      session: tabSession,
      partition,
      ownCookiesLabel,
      openedBy: options.openedBy ?? null,
      refs: new Map(),
      op: null,
      error: null,
      authRequest: null,
      authCallback: null,
      loading: false,
      attachedTo: null,
    };
    chat.tabs.set(id, tab);
    chat.activeTabId = id;
    this.byContents.set(view.webContents, tab);
    this.watch(tab);
    if (options.agentOp !== undefined) {
      this.attachAgentOp(tab, options.agentOp);
    }
    this.layout(chat);
    this.emitRun(runId, options.openedBy != null ? id : null);
    try {
      await options.beforeLoad?.(tabSession);
    } catch (error) {
      await this.closeTab(runId, id);
      throw error;
    }
    if (url !== null && chat.tabs.has(id)) {
      this.loadUrl(tab, url);
    }
    return id;
  }

  /** Starts loading `url` in the tab; the outcome arrives as state events. */
  loadUrl(tab: BrowserTab, url: string): void {
    const chat = this.chats.get(tab.runId);
    tab.error = null;
    tab.loading = true;
    if (chat !== undefined) {
      this.addRecent(chat, url);
    }
    tab.view.webContents.loadURL(url).catch(() => undefined);
    this.emitRun(tab.runId);
  }

  navigate(runId: string, tabId: string, input: string): void {
    const tab = this.requireTab(runId, tabId);
    const url = resolveAddress(input);
    if (url !== null) {
      this.noteUserAddress(runId, url);
      this.loadUrl(tab, url);
    }
  }

  /** Remember a host the user opened in this chat by their own press or typing. */
  noteUserAddress(runId: string, url: string): void {
    if (isWebUrl(url)) {
      this.chatOf(runId).userHosts.add(new URL(url).hostname.toLowerCase());
    }
  }

  userHosts(runId: string): string[] {
    return [...(this.chats.get(runId)?.userHosts ?? [])];
  }

  history(runId: string, tabId: string, action: BrowserHistoryAction): void {
    const tab = this.requireTab(runId, tabId);
    const contents = tab.view.webContents;
    if (action === 'back') {
      contents.navigationHistory.goBack();
    } else if (action === 'forward') {
      contents.navigationHistory.goForward();
    } else if (action === 'reload') {
      tab.error = null;
      contents.reload();
    } else {
      contents.stop();
    }
    this.emitRun(runId);
  }

  async closeTab(runId: string, tabId: string): Promise<void> {
    const chat = this.chats.get(runId);
    const tab = chat?.tabs.get(tabId);
    if (chat === undefined || tab === undefined) {
      return;
    }
    const order = [...chat.tabs.keys()];
    const index = order.indexOf(tabId);
    chat.tabs.delete(tabId);
    if (chat.activeTabId === tabId) {
      chat.activeTabId = order[index + 1] ?? order[index - 1] ?? null;
    }
    this.disposeTab(chat, tab);
    this.layout(chat);
    this.emitRun(runId);
  }

  selectTab(runId: string, tabId: string): void {
    const chat = this.chats.get(runId);
    if (chat === undefined || !chat.tabs.has(tabId)) {
      return;
    }
    chat.activeTabId = tabId;
    this.layout(chat);
    this.emitRun(runId);
  }

  setBounds(runId: string, bounds: BrowserBounds | null): void {
    const chat = this.chats.get(runId);
    if (chat === undefined) {
      return;
    }
    chat.bounds = bounds;
    this.layout(chat);
  }

  popOut(runId: string, title: string): void {
    const chat = this.chats.get(runId);
    if (chat === undefined) {
      return;
    }
    if (chat.popout !== null && !chat.popout.isDestroyed()) {
      chat.popout.focus();
      return;
    }
    const win = new BrowserWindow({
      ...POP_OUT_SIZE,
      title: `Browser — ${title}`,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('resize', () => this.layout(chat));
    win.on('close', () => this.dockBack(chat, win));
    this.popouts.add(win);
    chat.popout = win;
    chat.poppedOut = true;
    this.layout(chat);
    this.emitRun(runId);
  }

  dock(runId: string): void {
    const chat = this.chats.get(runId);
    const win = chat?.popout;
    if (chat === undefined || win === null || win === undefined) {
      return;
    }
    this.dockBack(chat, win);
    if (!win.isDestroyed()) {
      win.close();
    }
  }

  async tabAction(
    runId: string,
    tabId: string,
    action: BrowserTabAction,
  ): Promise<void> {
    const tab = this.requireTab(runId, tabId);
    const contents = tab.view.webContents;
    if (action === 'devtools') {
      contents.openDevTools({ mode: 'detach' });
    } else if (action === 'clearCookies') {
      await tab.session.clearStorageData({ storages: ['cookies'] });
    } else if (action === 'openExternal') {
      const url = contents.getURL();
      if (isWebUrl(url)) {
        await shell.openExternal(url);
      }
    } else {
      clipboard.writeText(contents.getURL());
    }
  }

  continueInsecure(runId: string, tabId: string): void {
    const tab = this.requireTab(runId, tabId);
    const failed = tab.error?.url ?? tab.view.webContents.getURL();
    const host = hostOf(failed);
    if (host === null || !isWebUrl(failed)) {
      return;
    }
    const remembered = this.insecureHosts.get(tab.session) ?? new Set<string>();
    remembered.add(host);
    this.insecureHosts.set(tab.session, remembered);
    this.loadUrl(tab, failed);
  }

  answerAuth(
    runId: string,
    tabId: string,
    credentials: { username: string; password: string } | null,
  ): void {
    const tab = this.requireTab(runId, tabId);
    const callback = tab.authCallback;
    tab.authCallback = null;
    tab.authRequest = null;
    if (callback !== null) {
      if (credentials === null) {
        callback();
      } else {
        callback(credentials.username, credentials.password);
      }
    }
    this.emitRun(runId);
  }

  async capture(runId: string): Promise<string | null> {
    const chat = this.chats.get(runId);
    const tab =
      chat?.activeTabId == null ? undefined : chat.tabs.get(chat.activeTabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) {
      return null;
    }
    try {
      const image = await tab.view.webContents.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  }

  async forgetRun(runId: string): Promise<void> {
    const chat = this.chats.get(runId);
    this.chats.delete(runId);
    if (chat !== undefined) {
      const win = chat.popout;
      chat.popout = null;
      chat.poppedOut = false;
      const tabs = [...chat.tabs.values()];
      chat.tabs.clear();
      for (const tab of tabs) {
        this.disposeTab(chat, tab);
      }
      if (win !== null) {
        this.popouts.delete(win);
        if (!win.isDestroyed()) {
          win.destroy();
        }
      }
    }
    if (chat !== undefined || (this.options.hasJarOnDisk?.(runId) ?? false)) {
      const jar = await this.chatSession(runId);
      await jar.clearStorageData();
    }
    this.emitState({
      state: {
        runId,
        tabs: [],
        activeTabId: null,
        poppedOut: false,
        recent: [],
      },
      agentOpenedTabId: null,
    });
  }

  stopAgent(runId: string, tabId: string): void {
    const tab = this.getTab(runId, tabId);
    if (tab?.op == null) {
      return;
    }
    tab.op.abort();
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.stop();
    }
  }

  attachAgentOp(tab: BrowserTab, op: AgentOp): void {
    tab.op = op;
    op.bind(() => {
      if (tab.op === op) {
        tab.op = null;
        this.emitRun(tab.runId);
      }
    });
    this.emitRun(tab.runId);
  }

  shutdown(): void {
    app.removeListener('certificate-error', this.onCertificateError);
    for (const chat of this.chats.values()) {
      const win = chat.popout;
      chat.popout = null;
      chat.poppedOut = false;
      for (const tab of chat.tabs.values()) {
        this.detach(tab);
      }
      if (win !== null && !win.isDestroyed()) {
        win.destroy();
      }
    }
    this.popouts.clear();
  }

  private chatOf(runId: string): ChatBrowser {
    let chat = this.chats.get(runId);
    if (chat === undefined) {
      chat = {
        runId,
        tabs: new Map(),
        activeTabId: null,
        poppedOut: false,
        popout: null,
        bounds: null,
        recent: [],
        counter: 0,
        userHosts: new Set(),
      };
      this.chats.set(runId, chat);
    }
    return chat;
  }

  private requireTab(runId: string, tabId: string): BrowserTab {
    const tab = this.getTab(runId, tabId);
    if (tab === undefined) {
      throw new Error(`No tab ${tabId} in this chat`);
    }
    return tab;
  }

  private addRecent(chat: ChatBrowser, url: string): void {
    chat.recent = [url, ...chat.recent.filter((entry) => entry !== url)].slice(
      0,
      RECENT_LIMIT,
    );
  }

  private disposeTab(chat: ChatBrowser, tab: BrowserTab): void {
    tab.op?.abort();
    tab.authCallback?.();
    tab.authCallback = null;
    this.detach(tab);
    const contents = tab.view.webContents;
    if (!contents.isDestroyed()) {
      contents.close();
    }
    const shared = [...chat.tabs.values()].some(
      (other) => other.partition === tab.partition,
    );
    if (tab.ownCookiesLabel !== null && !shared) {
      tab.session.clearStorageData().catch(() => undefined);
    }
  }

  private dockBack(chat: ChatBrowser, win: BrowserWindow): void {
    if (chat.popout !== win) {
      return;
    }
    chat.popout = null;
    chat.poppedOut = false;
    this.popouts.delete(win);
    for (const tab of chat.tabs.values()) {
      if (tab.attachedTo === win) {
        this.detach(tab);
      }
    }
    this.layout(chat);
    this.emitRun(chat.runId);
  }

  private detach(tab: BrowserTab): void {
    const host = tab.attachedTo;
    if (host === null) {
      return;
    }
    tab.attachedTo = null;
    if (!host.isDestroyed()) {
      host.contentView.removeChildView(tab.view);
    }
  }

  private layout(chat: ChatBrowser): void {
    const host = chat.poppedOut ? chat.popout : this.options.mainWindow();
    const placed =
      host !== null && !host.isDestroyed() && (chat.poppedOut || chat.bounds);
    for (const tab of chat.tabs.values()) {
      if (!placed || host === null || tab.id !== chat.activeTabId) {
        this.detach(tab);
        continue;
      }
      if (tab.attachedTo !== host) {
        this.detach(tab);
        host.contentView.addChildView(tab.view);
        tab.attachedTo = host;
      }
      if (chat.poppedOut) {
        const { width, height } = host.getContentBounds();
        tab.view.setBounds({ x: 0, y: 0, width, height });
      } else if (chat.bounds !== null) {
        tab.view.setBounds({
          x: Math.round(chat.bounds.x),
          y: Math.round(chat.bounds.y),
          width: Math.round(chat.bounds.width),
          height: Math.round(chat.bounds.height),
        });
      }
      tab.view.setVisible(true);
    }
  }

  private tabState(tab: BrowserTab): BrowserTabState {
    const contents = tab.view.webContents;
    const alive = !contents.isDestroyed();
    return {
      id: tab.id,
      url: alive ? contents.getURL() : '',
      title: alive ? contents.getTitle() : '',
      loading: tab.loading,
      canGoBack: alive && contents.navigationHistory.canGoBack(),
      canGoForward: alive && contents.navigationHistory.canGoForward(),
      error: tab.error,
      openedBy: tab.openedBy,
      ownCookiesLabel: tab.ownCookiesLabel,
      drivenBy: tab.op?.memberName ?? null,
      authRequest: tab.authRequest,
    };
  }

  private emitRun(runId: string, agentOpenedTabId: string | null = null): void {
    if (!this.chats.has(runId)) {
      return;
    }
    this.emitState({ state: this.state(runId), agentOpenedTabId });
  }

  private emitState(event: BrowserStateEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !this.popouts.has(win)) {
        win.webContents.send(IPC.onBrowserState, event);
      }
    }
  }

  private watch(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    const refresh = (): void => this.emitRun(tab.runId);
    contents.on('page-title-updated', refresh);
    contents.on('did-navigate-in-page', refresh);
    contents.on('did-navigate', () => {
      tab.refs.clear();
      refresh();
    });
    contents.on('did-start-loading', () => {
      tab.loading = true;
      refresh();
    });
    contents.on('did-stop-loading', () => {
      tab.loading = false;
      refresh();
    });
    contents.on('did-finish-load', () => {
      tab.error = null;
      refresh();
    });
    contents.on(
      'did-fail-load',
      (
        _event: unknown,
        code: number,
        description: string,
        url: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame || code === -3) {
          return;
        }
        tab.error = {
          code,
          description,
          url,
          certificate: code <= -200 && code >= -299,
        };
        refresh();
      },
    );
    contents.on('render-process-gone', () => {
      tab.error = {
        code: -1,
        description: 'The page crashed',
        url: contents.isDestroyed() ? '' : contents.getURL(),
        certificate: false,
      };
      tab.loading = false;
      refresh();
    });
    const guard = (event: NavigationEvent): void => {
      if (event.isMainFrame === false) {
        return;
      }
      if (!isWebUrl(event.url)) {
        event.preventDefault();
        return;
      }
      if (tab.op !== null && !tab.op.permitsNavigation(event.url)) {
        event.preventDefault();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-frame-navigate', guard);
    contents.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      if (tab.op !== null) {
        tab.op.authBlocked = true;
        callback();
        return;
      }
      tab.authCallback?.();
      tab.authCallback = callback;
      tab.authRequest = { host: authInfo.host, realm: authInfo.realm };
      refresh();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url) && (tab.op === null || tab.op.permitsNavigation(url))) {
        this.openTab(tab.runId, url, {
          openedBy: tab.op?.memberName ?? null,
          sameSessionAs: tab,
        }).catch((error: unknown) => {
          this.options.log?.(
            `could not open a popup tab: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return { action: 'deny' };
    });
  }
}
