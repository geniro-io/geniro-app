import type { Session } from 'electron';

import {
  AGENT_STOP_SENTENCE,
  AgentOp,
  navigationNeedsApproval,
} from './browser-agent-op';
import {
  BROWSER_SCREENSHOT_MAX_BASE64,
  type BrowserCookieInput,
  type BrowserOp,
  type BrowserReply,
  type BrowserRequest,
  browserRequestSchema,
} from './browser-agent-wire';
import {
  type BrowserTab,
  isWebUrl,
  type OpenTabOptions,
} from './browser-service';
import {
  type AxNode,
  byteLength,
  capBytes,
  composeSnapshot,
  formatAxTree,
} from './browser-snapshot';

const OP_TIMEOUT_MS = 18_000;
const LOAD_WAIT_MS = 15_000;
const SETTLE_MS = 150;
const SETTLE_LOAD_WAIT_MS = 5_000;
const CONSOLE_LIMIT = 200;
const CONSOLE_ENTRY_MAX = 1_000;
const EVALUATE_MAX_BYTES = 20 * 1024;
const FULL_PAGE_MAX_HEIGHT = 10_000;
const DEFAULT_SCROLL = 600;

export const SCREENSHOT_TOO_LARGE =
  'The screenshot is too large to send — take one without fullPage, or scroll and take several.';

/** What the executor needs from the service; `BrowserService` satisfies it. */
export interface BrowserAgentHost {
  getTab(runId: string, tabId: string): BrowserTab | undefined;
  listTabs(runId: string): BrowserTab[];
  activeTabId(runId: string): string | null;
  chatSession(runId: string): Promise<Session>;
  openTab(
    runId: string,
    url: string | null,
    options?: OpenTabOptions,
  ): Promise<string>;
  loadUrl(tab: BrowserTab, url: string): void;
  closeTab(runId: string, tabId: string): Promise<void>;
  attachAgentOp(tab: BrowserTab, op: AgentOp): void;
  /** Hosts the user opened in the chat themselves. */
  userHosts(runId: string): readonly string[];
}

class AgentError extends Error {}

interface Done {
  text: string;
  png?: string;
  viewPng?: string;
  tab?: string;
}

interface TabState {
  bound: boolean;
  enabled: boolean;
  console: string[];
}

const tabStates = new WeakMap<BrowserTab, TabState>();

interface Ctx {
  host: BrowserAgentHost;
  runId: string;
  tab: BrowserTab;
  op: AgentOp;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function stateOf(tab: BrowserTab): TabState {
  let state = tabStates.get(tab);
  if (state === undefined) {
    state = { bound: false, enabled: false, console: [] };
    tabStates.set(tab, state);
  }
  return state;
}

function remember(state: TabState, line: string): void {
  state.console.push(line.slice(0, CONSOLE_ENTRY_MAX));
  if (state.console.length > CONSOLE_LIMIT) {
    state.console.shift();
  }
}

interface RemoteObject {
  value?: unknown;
  description?: string;
}

function describeRemote(object: RemoteObject): string {
  if (typeof object.value === 'string') {
    return object.value;
  }
  if (object.value !== undefined) {
    return JSON.stringify(object.value);
  }
  return object.description ?? '';
}

async function ensureAttached(tab: BrowserTab): Promise<void> {
  const contents = tab.view.webContents;
  if (contents.isDevToolsOpened()) {
    throw new AgentError(
      'DevTools is open on this tab — close it and try again',
    );
  }
  const state = stateOf(tab);
  const dbg = contents.debugger;
  if (!state.bound) {
    state.bound = true;
    dbg.on('message', (_event, method, params: Record<string, unknown>) => {
      if (method === 'Runtime.consoleAPICalled') {
        const args = (params.args as RemoteObject[] | undefined) ?? [];
        remember(
          state,
          `[${String(params.type)}] ${args.map(describeRemote).join(' ')}`,
        );
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as
          { text?: string; exception?: RemoteObject } | undefined;
        remember(
          state,
          `[exception] ${details?.exception?.description ?? details?.text ?? 'Uncaught'}`,
        );
      }
    });
    dbg.on('detach', () => {
      state.enabled = false;
    });
  }
  if (!dbg.isAttached()) {
    state.enabled = false;
    try {
      dbg.attach('1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already attached/i.test(message)) {
        throw new AgentError(`Could not attach to the tab: ${message}`);
      }
    }
  }
  if (!state.enabled) {
    await dbg.sendCommand('Runtime.enable');
    state.enabled = true;
  }
}

async function guarded<T>(op: AgentOp, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AgentError(AGENT_STOP_SENTENCE));
    if (op.signal.aborted) {
      onAbort();
    }
    op.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      reject(
        new AgentError(
          `The browser operation took longer than ${OP_TIMEOUT_MS / 1000} s`,
        ),
      );
      op.abort();
    }, OP_TIMEOUT_MS);
  });
  const running = work();
  running.catch(() => undefined);
  try {
    return await Promise.race([running, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      op.signal.removeEventListener('abort', onAbort);
    }
  }
}

function waitForLoad(tab: BrowserTab, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const contents = tab.view.webContents;
    const done = (): void => {
      clearTimeout(timer);
      contents.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    contents.on('did-stop-loading', done);
  });
}

function checkOp(op: AgentOp): void {
  if (op.blockedHost !== null) {
    throw new AgentError(navigationNeedsApproval(op.blockedHost));
  }
  if (op.authBlocked) {
    throw new AgentError(
      'The page asks for a username and password; only the user can sign in to it.',
    );
  }
}

async function settle(ctx: Ctx): Promise<void> {
  await sleep(SETTLE_MS);
  if (ctx.tab.view.webContents.isLoading()) {
    await waitForLoad(ctx.tab, SETTLE_LOAD_WAIT_MS);
  }
  checkOp(ctx.op);
}

const staleRef = (ref: string): AgentError =>
  new AgentError(`ref ${ref} is gone — take a new snapshot`);

function nodeError(error: unknown, ref: string): AgentError {
  const message = error instanceof Error ? error.message : String(error);
  if (/box model|not visible|layout/i.test(message)) {
    return new AgentError(
      `ref ${ref} is not visible on the page — scroll to it or take a new snapshot`,
    );
  }
  if (
    /find node|no node|node with given|does not belong|not found/i.test(message)
  ) {
    return staleRef(ref);
  }
  return error instanceof AgentError
    ? error
    : new AgentError(`The browser operation failed: ${message}`);
}

function backendIdOf(tab: BrowserTab, ref: string): number {
  const id = tab.refs.get(ref);
  if (id === undefined) {
    throw staleRef(ref);
  }
  return id;
}

async function centreOf(
  ctx: Ctx,
  backendNodeId: number,
  ref: string,
): Promise<{ x: number; y: number }> {
  try {
    await ctx.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = await ctx.send<{ model: { content: number[] } }>(
      'DOM.getBoxModel',
      { backendNodeId },
    );
    const quad = model.content;
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  } catch (error) {
    throw nodeError(error, ref);
  }
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function keySpec(key: string): KeySpec {
  const named = NAMED_KEYS[key];
  if (named !== undefined) {
    return named;
  }
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    const code = /[a-z]/i.test(key)
      ? `Key${upper}`
      : /\d/.test(key)
        ? `Digit${key}`
        : '';
    return { key, code, keyCode: upper.charCodeAt(0), text: key };
  }
  throw new AgentError(
    `Unsupported key "${key}" — use Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown, Space or a single character`,
  );
}

async function pressKey(ctx: Ctx, key: string): Promise<void> {
  const spec = keySpec(key);
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };
  await ctx.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    ...(spec.text === undefined ? {} : { text: spec.text }),
  });
  await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

function cookieDetails(cookie: BrowserCookieInput): Electron.CookiesSetDetails {
  const url =
    cookie.url ??
    (cookie.domain === undefined
      ? undefined
      : `https://${cookie.domain.replace(/^\./, '')}${cookie.path ?? '/'}`);
  if (url === undefined) {
    throw new AgentError(`Cookie ${cookie.name} needs a url or a domain`);
  }
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
    ...(cookie.path === undefined ? {} : { path: cookie.path }),
    ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
    ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.expires === undefined ? {} : { expirationDate: cookie.expires }),
  };
}

async function putCookies(
  session: Session,
  cookies: readonly BrowserCookieInput[],
): Promise<void> {
  for (const cookie of cookies) {
    const details = cookieDetails(cookie);
    try {
      await session.cookies.set(details);
    } catch {
      throw new AgentError(`The browser refused cookie ${cookie.name}`);
    }
  }
}

function cookieUrl(cookie: Electron.Cookie): string {
  const host = (cookie.domain ?? '').replace(/^\./, '');
  return `${cookie.secure === true ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`;
}

const domainMatches = (cookieDomain: string, wanted: string): boolean => {
  const cookieHost = cookieDomain.replace(/^\./, '').toLowerCase();
  const wantedHost = wanted.replace(/^\./, '').toLowerCase();
  return cookieHost === wantedHost || cookieHost.endsWith(`.${wantedHost}`);
};

function describeCookie(cookie: Electron.Cookie): string {
  const expiry =
    cookie.expirationDate === undefined
      ? 'session'
      : new Date(cookie.expirationDate * 1000).toISOString();
  const flags = [
    cookie.secure ? 'secure' : null,
    cookie.httpOnly ? 'httpOnly' : null,
    `sameSite=${cookie.sameSite}`,
  ].filter((flag) => flag !== null);
  return `- ${cookie.name} · ${cookie.domain ?? ''} · ${cookie.path ?? '/'} · expires ${expiry} · ${flags.join(' ')} · value length ${cookie.value.length}`;
}

function parseWebUrl(url: string): string {
  if (!isWebUrl(url)) {
    throw new AgentError(`"${url}" is not an http or https address`);
  }
  return new URL(url).href;
}

const TITLE_MAX = 200;

const shortTitle = (title: string): string =>
  title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

const describeTab = (tab: BrowserTab): string => {
  const contents = tab.view.webContents;
  return `${tab.id} — ${contents.getTitle() || '(untitled)'} — ${contents.getURL() || '(blank)'}`;
};

async function openOp(
  host: BrowserAgentHost,
  req: BrowserRequest,
  op: Extract<BrowserOp, { kind: 'open' }>,
): Promise<Done> {
  const url = parseWebUrl(op.url);
  const agentOp = new AgentOp({
    memberName: req.memberName,
    allowedHosts: req.allowedHosts,
    vettedHosts: [new URL(url).hostname, ...host.userHosts(req.runId)],
  });
  try {
    return await guarded(agentOp, async () => {
      const id = await host.openTab(req.runId, null, {
        openedBy: req.memberName,
        agentOp,
        ...(op.ownCookies === undefined
          ? {}
          : {
              ownCookiesLabel: op.ownCookies.label,
              beforeLoad: (session: Session) =>
                putCookies(session, op.ownCookies?.cookies ?? []),
            }),
      });
      const tab = host.getTab(req.runId, id);
      if (tab === undefined) {
        throw new AgentError('The tab was closed before it loaded');
      }
      if (agentOp.signal.aborted) {
        await host.closeTab(req.runId, id);
        throw new AgentError(AGENT_STOP_SENTENCE);
      }
      const loaded = waitForLoad(tab, LOAD_WAIT_MS);
      host.loadUrl(tab, url);
      await loaded;
      if (agentOp.signal.aborted) {
        await host.closeTab(req.runId, id);
        throw new AgentError(AGENT_STOP_SENTENCE);
      }
      checkOp(agentOp);
      const contents = tab.view.webContents;
      const title = shortTitle(contents.getTitle());
      if (tab.error !== null) {
        return {
          text: `Opened ${url} as tab ${id}, but it did not load: ${tab.error.description}`,
          tab: id,
        };
      }
      return {
        text: `Opened ${contents.getURL() || url} as tab ${id}${title === '' ? '' : ` — ${title}`}`,
        tab: id,
      };
    });
  } finally {
    agentOp.end();
  }
}

async function tabOp(
  host: BrowserAgentHost,
  req: BrowserRequest,
  tabId: string,
  vettedHosts: string[],
  work: (ctx: Ctx) => Promise<Done>,
  readsCurrentPage = true,
): Promise<Done> {
  const tab = host.getTab(req.runId, tabId);
  if (tab === undefined) {
    throw new AgentError(`No tab ${tabId} in this chat — call browser_tabs`);
  }
  if (tab.op !== null) {
    throw new AgentError(
      `Tab ${tab.id} is busy with another browser call — try again in a moment`,
    );
  }
  const op = new AgentOp({
    memberName: req.memberName,
    allowedHosts: req.allowedHosts,
    vettedHosts: [...vettedHosts, ...host.userHosts(req.runId)],
  });
  const current = tab.view.webContents.getURL();
  if (readsCurrentPage && isWebUrl(current) && !op.permitsNavigation(current)) {
    throw new AgentError(navigationNeedsApproval(op.blockedHost ?? current));
  }
  host.attachAgentOp(tab, op);
  let attached: Promise<void> | null = null;
  const ctx: Ctx = {
    host,
    runId: req.runId,
    tab,
    op,
    send: async <T>(method: string, params?: Record<string, unknown>) => {
      attached ??= ensureAttached(tab);
      await attached;
      if (op.signal.aborted) {
        throw new AgentError(AGENT_STOP_SENTENCE);
      }
      return (await tab.view.webContents.debugger.sendCommand(
        method,
        params,
      )) as T;
    },
  };
  try {
    const done = await guarded(op, () => work(ctx));
    return { ...done, tab: done.tab ?? tab.id };
  } finally {
    if (op.signal.aborted && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.stop();
    }
    op.end();
  }
}

async function snapshot(
  ctx: Ctx,
  options: { interactive: boolean; text: boolean },
): Promise<Done> {
  const { nodes } = await ctx.send<{ nodes: AxNode[] }>(
    'Accessibility.getFullAXTree',
  );
  ctx.tab.refs.clear();
  let counter = 0;
  const tree = formatAxTree(
    nodes,
    (backendId) => {
      counter += 1;
      const ref = `e${counter}`;
      ctx.tab.refs.set(ref, backendId);
      return ref;
    },
    { interactiveOnly: options.interactive },
  );
  let pageText: string | null = null;
  if (options.text) {
    const evaluated = await ctx.send<{ result?: RemoteObject }>(
      'Runtime.evaluate',
      {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true,
      },
    );
    pageText =
      typeof evaluated.result?.value === 'string' ? evaluated.result.value : '';
  }
  const contents = ctx.tab.view.webContents;
  return {
    text: composeSnapshot({
      url: contents.getURL(),
      title: contents.getTitle(),
      tree,
      pageText,
    }),
  };
}

async function evaluate(ctx: Ctx, expression: string): Promise<Done> {
  const response = await ctx.send<{
    exceptionDetails?: { text?: string; exception?: RemoteObject };
    result?: RemoteObject & { type?: string };
  }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails !== undefined) {
    const details = response.exceptionDetails;
    throw new AgentError(
      `The expression threw: ${details.exception?.description ?? details.text ?? 'unknown error'}`,
    );
  }
  const result = response.result ?? {};
  const rendered =
    result.type === 'undefined'
      ? 'undefined'
      : result.value !== undefined
        ? (JSON.stringify(result.value) ?? 'undefined')
        : (result.description ?? String(result.type));
  await settle(ctx);
  if (byteLength(rendered) > EVALUATE_MAX_BYTES) {
    return {
      text: `${capBytes(rendered, EVALUATE_MAX_BYTES)}\n… result cut at 20 KB`,
    };
  }
  return { text: rendered };
}

interface ScreenshotOptions {
  fullPage: boolean;
  view: boolean;
  width?: number;
  height?: number;
}

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  contentSize: { width: number; height: number };
  cssVisualViewport?: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  };
}

async function screenshot(ctx: Ctx, options: ScreenshotOptions): Promise<Done> {
  const resized = options.width !== undefined || options.height !== undefined;
  if (resized) {
    await resizeViewport(ctx, options.width, options.height);
  }
  try {
    const area =
      options.fullPage || options.view || resized
        ? captureArea(
            await ctx.send<LayoutMetrics>('Page.getLayoutMetrics'),
            options.fullPage,
          )
        : null;
    const full = await capture(ctx, area, 1, options.fullPage);
    let viewPng: string | undefined;
    if (options.view && area !== null) {
      const ratio = await devicePixelRatio(ctx);
      viewPng =
        ratio > 1
          ? await capture(ctx, area, 1 / ratio, options.fullPage)
          : full;
    }
    if (
      full.length + (viewPng === full ? 0 : (viewPng?.length ?? 0)) >
      BROWSER_SCREENSHOT_MAX_BASE64
    ) {
      throw new AgentError(SCREENSHOT_TOO_LARGE);
    }
    const contents = ctx.tab.view.webContents;
    const size =
      area === null
        ? ''
        : ` (${Math.round(area.width)}×${Math.round(area.height)} CSS px)`;
    return {
      text: `Screenshot of tab ${ctx.tab.id}${size} — ${contents.getURL()}`,
      png: full,
      ...(viewPng === undefined ? {} : { viewPng }),
    };
  } finally {
    if (resized) {
      await ctx
        .send('Emulation.clearDeviceMetricsOverride')
        .catch(() => undefined);
    }
  }
}

function captureArea(
  metrics: LayoutMetrics,
  fullPage: boolean,
): { x: number; y: number; width: number; height: number } {
  if (fullPage) {
    const size = metrics.cssContentSize ?? metrics.contentSize;
    return {
      x: 0,
      y: 0,
      width: size.width,
      height: Math.min(size.height, FULL_PAGE_MAX_HEIGHT),
    };
  }
  const viewport = metrics.cssVisualViewport;
  if (viewport === undefined) {
    const size = metrics.cssContentSize ?? metrics.contentSize;
    return { x: 0, y: 0, width: size.width, height: size.height };
  }
  return {
    x: viewport.pageX,
    y: viewport.pageY,
    width: viewport.clientWidth,
    height: viewport.clientHeight,
  };
}

async function capture(
  ctx: Ctx,
  area: { x: number; y: number; width: number; height: number } | null,
  scale: number,
  fullPage: boolean,
): Promise<string> {
  const params =
    area === null || (!fullPage && scale === 1)
      ? { format: 'png' }
      : {
          format: 'png',
          captureBeyondViewport: fullPage,
          clip: { ...area, scale },
        };
  const { data } = await ctx.send<{ data: string }>(
    'Page.captureScreenshot',
    params,
  );
  if (data.length > BROWSER_SCREENSHOT_MAX_BASE64) {
    throw new AgentError(SCREENSHOT_TOO_LARGE);
  }
  return data;
}

async function devicePixelRatio(ctx: Ctx): Promise<number> {
  const answer = await ctx.send<{ result?: RemoteObject }>('Runtime.evaluate', {
    expression: 'devicePixelRatio',
    returnByValue: true,
  });
  const ratio = answer.result?.value;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0
    ? ratio
    : 1;
}

async function resizeViewport(
  ctx: Ctx,
  width: number | undefined,
  height: number | undefined,
): Promise<void> {
  const current = await ctx.send<{ result?: RemoteObject }>(
    'Runtime.evaluate',
    {
      expression: '[innerWidth, innerHeight]',
      returnByValue: true,
    },
  );
  const [innerWidth, innerHeight] = Array.isArray(current.result?.value)
    ? (current.result.value as unknown[])
    : [];
  await ctx.send('Emulation.setDeviceMetricsOverride', {
    width: width ?? (typeof innerWidth === 'number' ? innerWidth : 1280),
    height: height ?? (typeof innerHeight === 'number' ? innerHeight : 800),
    deviceScaleFactor: 0,
    mobile: false,
  });
  await ctx.send('Runtime.evaluate', {
    expression:
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    awaitPromise: true,
    returnByValue: true,
  });
}

async function selectOption(
  ctx: Ctx,
  ref: string,
  values: string[],
): Promise<Done> {
  const backendNodeId = backendIdOf(ctx.tab, ref);
  try {
    const { object } = await ctx.send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId },
    );
    const response = await ctx.send<{ result?: RemoteObject }>(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function (values) {
        if (this.tagName !== 'SELECT') { return null; }
        const wanted = new Set(values);
        for (const option of this.options) {
          option.selected = wanted.has(option.value) || wanted.has(option.label) || wanted.has(option.text.trim());
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(this.selectedOptions, (option) => option.text.trim());
      }`,
        arguments: [{ value: values }],
        returnByValue: true,
      },
    );
    const selected = response.result?.value;
    if (!Array.isArray(selected)) {
      throw new AgentError(`ref ${ref} is not a select element`);
    }
    await settle(ctx);
    return {
      text:
        selected.length === 0
          ? 'No option matched; nothing is selected'
          : `Selected: ${selected.map(String).join(', ')}`,
    };
  } catch (error) {
    throw nodeError(error, ref);
  }
}

async function typeInto(
  ctx: Ctx,
  ref: string,
  text: string,
  submit: boolean,
): Promise<Done> {
  const backendNodeId = backendIdOf(ctx.tab, ref);
  try {
    await ctx.send('DOM.focus', { backendNodeId });
  } catch (error) {
    throw nodeError(error, ref);
  }
  try {
    const { object } = await ctx.send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId },
    );
    await ctx.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { if (typeof this.select === "function") { this.select(); } }',
    });
  } catch {
    // typing still works without selecting the old text
  }
  await ctx.send('Input.insertText', { text });
  if (submit) {
    await pressKey(ctx, 'Enter');
    await settle(ctx);
  }
  return { text: `Typed ${text.length} character(s) into ${ref}` };
}

async function scroll(
  ctx: Ctx,
  ref: string | undefined,
  dy: number | undefined,
): Promise<Done> {
  if (ref !== undefined) {
    await centreOf(ctx, backendIdOf(ctx.tab, ref), ref);
    await settle(ctx);
    return { text: `Scrolled ${ref} into view` };
  }
  const amount = dy ?? DEFAULT_SCROLL;
  const moved = await ctx.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    {
      expression: `(() => { const before = scrollY; scrollBy({ top: ${amount}, behavior: 'instant' }); return scrollY - before; })()`,
      returnByValue: true,
    },
  );
  await settle(ctx);
  const by = moved.result?.value;
  return {
    text:
      typeof by === 'number'
        ? `Scrolled by ${by} px (asked for ${amount})`
        : `Scrolled by ${amount} px`,
  };
}

async function cookieSession(
  host: BrowserAgentHost,
  req: BrowserRequest,
  tabId: string | undefined,
): Promise<Session> {
  if (tabId === undefined) {
    return host.chatSession(req.runId);
  }
  const tab = host.getTab(req.runId, tabId);
  if (tab === undefined) {
    throw new AgentError(`No tab ${tabId} in this chat — call browser_tabs`);
  }
  return tab.session;
}

async function execute(
  host: BrowserAgentHost,
  req: BrowserRequest,
  op: BrowserOp,
): Promise<Done> {
  switch (op.kind) {
    case 'open':
      return openOp(host, req, op);
    case 'navigate': {
      const url = parseWebUrl(op.url);
      return tabOp(
        host,
        req,
        op.tab,
        [new URL(url).hostname],
        async (ctx) => {
          const loaded = waitForLoad(ctx.tab, LOAD_WAIT_MS);
          host.loadUrl(ctx.tab, url);
          await loaded;
          checkOp(ctx.op);
          if (ctx.tab.error !== null) {
            throw new AgentError(
              `Could not load ${url}: ${ctx.tab.error.description}`,
            );
          }
          const contents = ctx.tab.view.webContents;
          return {
            text: `Navigated tab ${ctx.tab.id} to ${contents.getURL() || url}`,
          };
        },
        false,
      );
    }
    case 'snapshot':
      return tabOp(host, req, op.tab, [], (ctx) =>
        snapshot(ctx, { interactive: op.interactive, text: op.text }),
      );
    case 'click':
      return tabOp(host, req, op.tab, [], async (ctx) => {
        const point = await centreOf(ctx, backendIdOf(ctx.tab, op.ref), op.ref);
        const mouse = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
        await ctx.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
        });
        await ctx.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...mouse,
        });
        await ctx.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...mouse,
        });
        await settle(ctx);
        return { text: `Clicked ${op.ref}` };
      });
    case 'type':
      return tabOp(host, req, op.tab, [], (ctx) =>
        typeInto(ctx, op.ref, op.text, op.submit),
      );
    case 'press':
      return tabOp(host, req, op.tab, [], async (ctx) => {
        await pressKey(ctx, op.key);
        await settle(ctx);
        return { text: `Pressed ${op.key}` };
      });
    case 'select':
      return tabOp(host, req, op.tab, [], (ctx) =>
        selectOption(ctx, op.ref, op.values),
      );
    case 'scroll':
      return tabOp(host, req, op.tab, [], (ctx) => scroll(ctx, op.ref, op.dy));
    case 'screenshot':
      return tabOp(host, req, op.tab, [], (ctx) =>
        screenshot(ctx, {
          fullPage: op.fullPage,
          view: op.view,
          ...(op.width === undefined ? {} : { width: op.width }),
          ...(op.height === undefined ? {} : { height: op.height }),
        }),
      );
    case 'console':
      return tabOp(host, req, op.tab, [], async (ctx) => {
        await ctx.send('Runtime.enable');
        const entries = stateOf(ctx.tab).console;
        return {
          text:
            entries.length === 0
              ? 'No console messages since the browser attached to this tab.'
              : entries.join('\n'),
        };
      });
    case 'evaluate':
      return tabOp(host, req, op.tab, [], (ctx) =>
        evaluate(ctx, op.expression),
      );
    case 'tabs': {
      const tabs = host.listTabs(req.runId);
      if (tabs.length === 0) {
        return { text: 'No tabs are open in this chat.' };
      }
      const active = host.activeTabId(req.runId);
      return {
        text: tabs
          .map((tab) => {
            const notes = [
              tab.id === active ? 'active' : null,
              tab.openedBy === null ? null : `opened by ${tab.openedBy}`,
              tab.ownCookiesLabel === null
                ? null
                : `own cookies: ${tab.ownCookiesLabel}`,
            ].filter((note) => note !== null);
            return `${describeTab(tab)}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`;
          })
          .join('\n'),
      };
    }
    case 'close': {
      const tab = host.getTab(req.runId, op.tab);
      if (tab === undefined) {
        throw new AgentError(
          `No tab ${op.tab} in this chat — call browser_tabs`,
        );
      }
      await host.closeTab(req.runId, op.tab);
      return { text: `Closed tab ${op.tab}` };
    }
    case 'setCookies': {
      const session = await cookieSession(host, req, op.tab);
      await putCookies(session, op.cookies);
      return {
        text: `Set ${op.cookies.length} cookie(s)`,
        ...(op.tab === undefined ? {} : { tab: op.tab }),
      };
    }
    case 'getCookies': {
      const session = await cookieSession(host, req, op.tab);
      const cookies = await session.cookies.get(
        op.url === undefined ? {} : { url: op.url },
      );
      return {
        text:
          cookies.length === 0
            ? 'No cookies.'
            : cookies.map(describeCookie).join('\n'),
        ...(op.tab === undefined ? {} : { tab: op.tab }),
      };
    }
    case 'clearCookies': {
      const session = await cookieSession(host, req, op.tab);
      if (op.domain === undefined) {
        const all = await session.cookies.get({});
        await session.clearStorageData({ storages: ['cookies'] });
        return { text: `Cleared ${all.length} cookie(s)` };
      }
      const wanted = op.domain;
      const matching = (await session.cookies.get({})).filter((cookie) =>
        domainMatches(cookie.domain ?? '', wanted),
      );
      for (const cookie of matching) {
        await session.cookies.remove(cookieUrl(cookie), cookie.name);
      }
      return { text: `Cleared ${matching.length} cookie(s) for ${wanted}` };
    }
  }
}

function requestIdOf(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const id = (raw as { id: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

/** Runs one operation the daemon relayed and answers the reply it sends back. */
export async function runBrowserAgentRequest(
  host: BrowserAgentHost,
  raw: unknown,
): Promise<BrowserReply> {
  const parsed = browserRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      id: requestIdOf(raw),
      ok: false,
      error: parsed.error.issues
        .map(
          (issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`,
        )
        .join('; '),
    };
  }
  const request = parsed.data;
  try {
    const done = await execute(host, request, request.op);
    return { id: request.id, ok: true, ...done };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error:
        error instanceof AgentError
          ? error.message
          : `The browser operation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
