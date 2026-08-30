// REPL driver for the Geniro desktop UI on headless Linux (Claude Code on the web).
//
// The packaged Electron SHELL can't launch here — the Electron binary download
// is blocked by the container's egress policy (403 from github releases). So we
// drive the SAME renderer bundle the Electron window loads, in the pre-installed
// Chromium, wired to a REAL daemon (spawned under host Node), with window.geniro
// stubbed to hand the renderer a live daemon handle + an onboarded state.
//
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
// Commands: launch, caps, nav <Chats|Graphs|Settings>, seed-workflow,
//   fill <sel> <text…>, click <sel>, click-text <text…>, send, approve, deny,
//   ss [name], js <expr>, text [sel], options <sel>, quit.
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

// Repo root = three levels up from .claude/skills/run-desktop/.
const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(APP_DIR, 'apps/ui/out/renderer');
const DAEMON_MAIN = path.join(APP_DIR, 'apps/daemon/dist/main.js');
const UD = path.join(os.tmpdir(), 'geniro-run-ud');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
// The agent's working dir for chats — a throwaway so tool calls never touch the repo.
const RUN_CWD = process.env.GENIRO_RUN_CWD || path.join(os.tmpdir(), 'geniro-run-cwd');
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.mkdirSync(RUN_CWD, { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Playwright's Chromium, wherever this host keeps it. Two roots and two layouts
 * because the harness runs in two places: the Linux container images it at
 * /opt/pw-browsers, while a macOS checkout has whatever `playwright install`
 * put in ~/Library/Caches/ms-playwright. Newest build wins — a machine
 * accumulates one directory per Playwright release and the oldest of them can
 * predate the protocol playwright-core speaks.
 */
function findChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ].filter(Boolean);
  const found = [];
  for (const base of roots) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      if (!d.startsWith('chromium-')) continue;
      // Four layouts, because the binary's name and its directory both vary by
      // platform AND by how Playwright built it: Linux ships a bare `chrome`,
      // macOS an .app bundle, and recent macOS builds are "Google Chrome for
      // Testing" under an -arm64 directory rather than "Chromium".
      for (const rel of [
        'chrome-linux/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) found.push(p);
      }
    }
  }
  if (found.length === 0) {
    throw new Error(`Chromium not found under ${roots.join(', ')} — run: npx playwright install chromium`);
  }
  return found[found.length - 1];
}
// Both CLIs are resolved the same way. cursor-agent used to be hardcoded as
// `found: false`, which the renderer renders as "not installed" and refuses to
// select — so a machine with cursor installed could not drive a cursor chat at
// all, and anything to be shown about that agent had to be created behind the
// UI's back (where the chat list never picks it up).
function findCli(name) {
  try { return execSync(`command -v ${name}`, { shell: '/bin/bash' }).toString().trim() || null; } catch { return null; }
}
// Load playwright-core from a SIDE dir — never the repo's pnpm node_modules
// (npm-installing into a pnpm workspace prunes hoisted deps and breaks it).
async function loadChromium() {
  const dirs = [];
  if (process.env.GENIRO_PW) dirs.push(process.env.GENIRO_PW);
  dirs.push(path.join(os.homedir(), '.geniro-run-pw/node_modules/playwright-core'));
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const entry = path.join(dir, pkg.main || 'index.js');
      const mod = await import(pathToFileURL(entry).href);
      // playwright-core is CJS: from ESM its exports land on `.default`.
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* try next candidate */ }
  }
  try { const mod = await import('playwright-core'); return mod.chromium ?? mod.default?.chromium; } catch { /* not in repo either */ }
  throw new Error('playwright-core not found. Install it OUTSIDE the repo:\n  mkdir -p ~/.geniro-run-pw && npm i --prefix ~/.geniro-run-pw playwright-core');
}

const CT = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json', '.ico': 'image/x-icon' };
function startStatic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.join(OUT, p);
      if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(fs.readFileSync(path.join(OUT, 'index.html')));
      }
      res.writeHead(200, { 'content-type': CT[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
/**
 * Electron's own binary, or null to fall back to whatever node is running this.
 * Resolved from the workspace install rather than PATH — there is no `electron`
 * on PATH, and the one that matters is the version this repo's native modules
 * were built against.
 */
function ELECTRON_BIN() {
  for (const rel of ['node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
                     'node_modules/electron/dist/electron']) {
    const p = path.join(APP_DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    fs.rmSync(UD, { recursive: true, force: true });
    fs.mkdirSync(path.join(UD, 'workflows'), { recursive: true });
    // Under ELECTRON's node, exactly as `pnpm dev` and the packaged app run it
    // — NOT host node. `better-sqlite3` is native, so it loads under one ABI or
    // the other and the repo builds it for Electron (`pnpm rebuild:native`,
    // which `pnpm install` runs). Spawning host node here meant the harness and
    // the real app could never both work: whichever ABI was on disk broke the
    // other, and the symptom is a NODE_MODULE_VERSION error at daemon boot.
    const electron = ELECTRON_BIN();
    const child = spawn(electron ?? process.execPath, [DAEMON_MAIN], {
      env: {
        ...process.env, GENIRO_USER_DATA: UD, GENIRO_PORT: '0', NODE_ENV: 'production',
        ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (/GENIRO_DAEMON_READY \{"port":(\d+)\}/.test(buf)) {
        const pf = JSON.parse(fs.readFileSync(path.join(UD, 'daemon.json'), 'utf8'));
        resolve({ child, handle: { host: pf.host, port: pf.port, token: pf.token, version: pf.version } });
      }
    });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    child.on('exit', (c) => reject(new Error('daemon exited code=' + c + '. Did you `npm rebuild better-sqlite3` for host Node ABI + `pnpm build`?\n' + buf.slice(-1200))));
    setTimeout(() => reject(new Error('daemon ready timeout\n' + buf.slice(-1200))), 30000);
  });
}
function stubScript(handle) {
  const h = JSON.stringify(handle);
  const cwd = JSON.stringify(RUN_CWD);
  const gitStub = JSON.stringify(process.env.GENIRO_RUN_GIT === 'dirty');
  const claude = JSON.stringify(findCli('claude') || '/usr/bin/claude');
  const cursorPath = findCli('cursor-agent');
  const cursor = JSON.stringify(cursorPath);
  // The agent CONFIG directory every chat opens under, so a run can be driven
  // against a profile other than the default — which is how a rate-limited
  // default account is worked around without touching the user's own settings.
  const configDir = JSON.stringify(process.env.GENIRO_RUN_CONFIG_DIR ?? null);
  const recentConfigDirs = process.env.GENIRO_RUN_CONFIG_DIR
    ? `[${configDir}]`
    : '[]';
  // The thread's pull requests, keyed by URL, read from a JSON file at
  // `GENIRO_RUN_PRS` — see `getPullRequestsByRef` below.
  const seededPullRequests = JSON.stringify(
    process.env.GENIRO_RUN_PRS
      ? JSON.parse(fs.readFileSync(process.env.GENIRO_RUN_PRS, 'utf8'))
      : {},
  );
  // Extra settings keys the stub should answer with, read from a JSON file at
  // `GENIRO_RUN_SETTINGS`. The stub's own object is a minimal fixture, so any
  // feature whose data lives in settings.json (saved run configurations, fast
  // actions) is otherwise unreachable here — and driving one through the `js`
  // command means pasting the whole list into a REPL line, which jams tmux at
  // a few hundred characters. It seeds the SAME `window.__geniroSettings` the
  // stub already merges, so a write from the app still wins over it.
  const seededSettings = JSON.stringify(
    process.env.GENIRO_RUN_SETTINGS
      ? JSON.parse(fs.readFileSync(process.env.GENIRO_RUN_SETTINGS, 'utf8'))
      : {},
  );
  // The update surface is unreachable here otherwise: main is what decides
  // there is a release, and this harness has no main. `GENIRO_FAKE_UPDATE`
  // makes the stub report one so the nav rail's update control can actually be
  // driven and screenshotted — set it to a version (`1.47.0`), optionally with
  // a phase after a colon (`1.47.0:downloading:0.62`).
  const [fakeVersion, fakePhase = 'available', fakeProgress = null] = (
    process.env.GENIRO_FAKE_UPDATE ?? ''
  ).split(':');
  const updateState = JSON.stringify({
    phase: fakeVersion ? fakePhase : 'idle',
    version: fakeVersion || null,
    progress: fakeProgress === null ? null : Number(fakeProgress),
    message: null,
    currentVersion: '0.0.0-run-desktop',
    // True only for a faked offer — a real unpackaged launch can install
    // nothing, and saying otherwise would hide the control under test.
    canInstall: Boolean(fakeVersion),
  });
  return `window.__geniroSettings = { ...${seededSettings}, ...(window.__geniroSettings ?? {}) };
  window.__geniroPullRequests = ${seededPullRequests};
  window.geniro = {
    getStatus: async () => ({ onboardingComplete: true, daemon: { connected: true, handle: ${h} } }),
    getDaemonHandle: async () => (${h}),
    onDaemonRestarted: () => () => {},
    pickProjectFolder: async () => ${cwd}, pickAgentBinary: async () => null,
    // Every key the renderer WRITES is remembered, not just the one the
    // harness happened to need first: a setting that cannot round-trip here
    // looks exactly like a feature that does not work — the transcript's
    // collapse-tool-steps switch was driven and read back as unchanged.
    getSettings: async () => ({ onboardingComplete: true, projectFolder: ${cwd}, recentFolders: [${cwd}], configDir: ${configDir}, recentConfigDirs: ${recentConfigDirs}, lastChatTarget: 'claude', cliPaths: {}, checkForUpdates: false, notificationsEnabled: window.__geniroNotificationsEnabled !== false, ...(window.__geniroSettings ?? {}) }),
    updateSettings: async (p) => { if (p.notificationsEnabled !== undefined) window.__geniroNotificationsEnabled = p.notificationsEnabled; window.__geniroSettings = { ...(window.__geniroSettings ?? {}), ...p }; return { onboardingComplete: true, projectFolder: ${cwd}, recentFolders: [${cwd}], configDir: ${configDir}, recentConfigDirs: ${recentConfigDirs}, lastChatTarget: 'claude', cliPaths: {}, checkForUpdates: false, notificationsEnabled: window.__geniroNotificationsEnabled !== false, ...window.__geniroSettings }; },
    detectClis: async () => ([{ kind: 'claude', found: true, path: ${claude}, version: 'detected', loggedIn: null }, { kind: 'cursor-agent', found: ${cursorPath ? 'true' : 'false'}, path: ${cursor}, version: ${cursorPath ? "'detected'" : 'null'}, loggedIn: null }]),
    completeOnboarding: async () => {},
    // Settings' CLI sign-in resolves through the daemon and then hands the
    // invocation here. Without the stub the button throws instead of no-opping,
    // which reads as a broken control rather than a stubbed one.
    openInTerminal: async () => ({ ok: true }),
    pickWorkflowImport: async () => null, pickWorkflowExport: async () => null,
    // App self-update. There is no main process here, so nothing can actually
    // update — but the shell SUBSCRIBES on mount (\`use-update-state.ts\`), so a
    // missing \`onUpdateState\` throws the whole app to its error boundary
    // before any view renders. The state is the honest one for this harness:
    // an unpackaged launch that cannot replace itself.
    getUpdateState: async () => (${updateState}),
    checkForUpdates: async () => (${JSON.stringify({
      phase: 'up-to-date',
      version: null,
      progress: null,
      message: null,
      currentVersion: '0.0.0-run-desktop',
      canInstall: false,
    })}),
    installUpdate: async () => (${JSON.stringify({
      phase: 'error',
      version: null,
      progress: null,
      message: 'the run-desktop harness has no main process to install from',
      currentVersion: '0.0.0-run-desktop',
      canInstall: false,
    })}),
    relaunchForUpdate: async () => {},
    onUpdateState: () => () => {},
    // The composer's branch chip calls these on mount; without them the whole
    // app shell throws to its error boundary before any view renders.
    //
    // GENIRO_RUN_GIT=dirty swaps the not-a-repo default for a repo with two
    // branches and an unclean tree — the one state the composer's git strip has
    // anything to say in. What it drives is the RENDERER's half (warning tone,
    // the Pull offer, what a refused pull does to the strip); the git mechanics
    // behind those calls are real-repository territory and are tested there, in
    // apps/ui/src/main/git-info.spec.ts.
    getGitInfo: async () => (${gitStub}
      ? { isRepo: true, branch: 'main', branches: ['main', 'dev'], dirty: true }
      : { isRepo: false, branch: null, branches: [], dirty: false }),
    switchBranch: async () => (${gitStub}
      ? { ok: false, branch: 'main', error: 'Uncommitted changes in this folder — the branch stays put', dirty: true }
      : { ok: false, branch: null, error: 'not a repo in the run-desktop stub', dirty: false }),
    pullBranch: async () => (${gitStub}
      ? { ok: true, branch: 'main', error: null, stashLeft: null }
      : { ok: false, branch: null, error: 'not a repo in the run-desktop stub', stashLeft: null }),
    // The pull requests a THREAD opened. Answered from the seed file rather
    // than from the gh CLI: there is no main process here to spawn it, and the
    // renderer's half — which chip is current, how the shelf lays out, what
    // the panel groups — is what this harness exists to drive. Seed it from
    // real 'gh pr view --json' output so the rows are a real repository's.
    getPullRequestsByRef: async (refs) => refs.map((ref) => ({
      ref,
      pullRequest: (window.__geniroPullRequests ?? {})[ref.url] ?? null,
    })),
    // The BRANCH query beside it (the second source). Empty by default: a
    // throwaway cwd is not a checkout, and failing closed is what the real one
    // does with no gh on the machine.
    getPullRequests: async () => ({ branch: null, originOwner: null, pullRequests: [] }),
    // System notifications. There is no main process here, so a real macOS
    // banner is impossible — the calls are RECORDED instead, which is what
    // makes the half this harness CAN answer ("which thread earns one, and
    // when") demonstrable: read them with
    //   js JSON.stringify(window.__geniroNotifications ?? [])
    // The banner itself has to be seen in the real Electron app.
    notify: async (n) => { (window.__geniroNotifications ??= []).push(n); },
    onNotificationActivated: () => () => {},
    // The menu bar's Clear Agent Cache row. Subscribed unconditionally by the
    // shell, so — like \`onUpdateState\` above — a missing member is not a
    // degraded feature here but the whole app on its error boundary.
    onClearAgentCaches: () => () => {},
    toggleDevTools: async () => {},
  };`;
}

const SEED_WORKFLOW = `name: Permission demo
nodes:
  - { id: start, kind: trigger, trigger: manual, name: Start }
  - { id: reviewer, kind: agent, agent: claude, approval: acceptEdits, name: Reviewer, role: Reviews the diff and approves safe edits automatically. }
  - { id: runner, kind: agent, agent: claude, approval: auto, name: Runner, role: Executes the approved plan. }
edges:
  - { from: start, to: reviewer, kind: data }
  - { from: reviewer, to: runner, kind: data }
layout:
  start: { x: 40, y: 160 }
  reviewer: { x: 320, y: 160 }
  runner: { x: 600, y: 160 }
`;

let daemon = null, staticSrv = null, browser = null, ctx = null, page = null, handle = null;

const clickByText = (text) => page.evaluate((t) => {
  const els = [...document.querySelectorAll('button, a, [role="button"]')].filter((e) => e.offsetParent !== null);
  const el = els.find((e) => e.textContent.trim() === t) ?? els.find((e) => e.textContent.includes(t));
  if (!el) return 'NOT_FOUND';
  el.click(); return 'OK';
}, text);

const COMMANDS = {
  async launch() {
    if (browser) return log('already launched');
    const chromium = await loadChromium();
    staticSrv = await startStatic();
    const staticPort = staticSrv.address().port;
    const d = await startDaemon(); daemon = d.child; handle = d.handle;
    log('daemon on', handle.port, '· warming capabilities probe…');
    // Warm the claude modes probe so the plan option is live before we render.
    const capUrl = `http://${handle.host}:${handle.port}/v1/capabilities`;
    const auth = { headers: { authorization: `Bearer ${handle.token}` } };
    for (let i = 0; i < 20; i++) { try { const j = await (await fetch(capUrl, auth)).json(); if (j.claudeModes.acceptEdits !== 'unknown') { log('capabilities:', JSON.stringify(j)); break; } } catch {} await sleep(2000); }
    // Headless by default (the Linux container has no display), but a real
    // window on request: `GENIRO_HEADED=1` is how a human on a Mac watches the
    // same session the driver is scripting, instead of reading screenshots of
    // it afterwards. `--disable-gpu` is dropped when headed — with it the
    // window renders but paints nothing on macOS.
    const headed = process.env.GENIRO_HEADED === '1';
    browser = await chromium.launch({
      executablePath: findChromium(),
      headless: !headed,
      args: ['--no-sandbox', '--disable-web-security', '--force-color-profile=srgb', ...(headed ? [] : ['--disable-gpu'])],
    });
    ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    page.on('pageerror', (e) => log('PAGEERROR', e.message));
    await page.addInitScript(stubScript(handle));
    await page.goto(`http://127.0.0.1:${staticPort}/index.html`, { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector('[aria-label="Tool-approval mode"], nav', { timeout: 20000 }); log('app shell ready ✓'); }
    catch { log('WARN: app shell not detected in 20s'); }
  },
  async caps() { const j = await (await fetch(`http://${handle.host}:${handle.port}/v1/capabilities`, { headers: { authorization: `Bearer ${handle.token}` } })).json(); log(JSON.stringify(j, null, 2)); },
  async nav(view) { log('nav', view, '→', await clickByText(view)); await sleep(700); },
  async 'seed-workflow'() { fs.writeFileSync(path.join(UD, 'workflows', 'permission-demo.geniro.yaml'), SEED_WORKFLOW); log('seeded permission-demo.geniro.yaml (nav Graphs to see it)'); },
  async fill(rest) { const i = rest.indexOf(' '); const sel = rest.slice(0, i); const val = rest.slice(i + 1); await page.fill(sel, val); log('filled', sel); },
  async click(sel) { try { await page.click(sel, { timeout: 5000 }); log('clicked', sel); } catch { log('click via DOM', await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'NOT_FOUND'; e.click(); return 'OK'; }, sel)); } },
  async 'click-text'(text) { log('click-text', JSON.stringify(text), '→', await clickByText(text)); },
  // Pointer drag between two elements' centres: `mdrag <fromSel> -> <toSel>`.
  // React Flow wires an edge from pointer events on its handles, which neither
  // `click` nor an HTML5 drag can express — the handles are not clickable and
  // carry no dataTransfer. Moves in steps because React Flow only starts a
  // connection once it has seen the pointer travel.
  async mdrag(rest) {
    const [from, to] = rest.split('->').map((s) => s.trim());
    const a = await page.locator(from).first().boundingBox();
    const b = await page.locator(to).first().boundingBox();
    if (!a || !b) return log('mdrag: NOT_FOUND', !a ? from : to);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
    log('mdrag', from, '→', to);
  },
  async send() { log('send →', await page.evaluate(() => { const b = document.querySelector('button[aria-label="Send"], button[aria-label="Start run"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'OK'; })); },
  async approve() { log('approve →', await clickByText('Approve')); },
  async deny() { log('deny →', await clickByText('Deny')); },
  async ss(name) { const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png'); await page.screenshot({ path: f }); log('screenshot:', f); },
  // One ELEMENT, not the window: `ss-el <name> <css-sel>`. A full-window shot of
  // a 220px rail or a status row is mostly empty page, and the detail the change
  // is about ends up a few pixels tall — which is exactly the case where a
  // screenshot is being used to judge a visual decision.
  async 'ss-el'(rest) {
    const i = rest.indexOf(' ');
    if (i === -1) return log('usage: ss-el <name> <css-sel>');
    const f = path.join(SHOT_DIR, rest.slice(0, i) + '.png');
    const el = page.locator(rest.slice(i + 1)).first();
    if (await el.count() === 0) return log('ss-el: NOT_FOUND', rest.slice(i + 1));
    await el.screenshot({ path: f });
    log('screenshot:', f);
  },
  // Run an expression in the page (Playwright page.evaluate — page context, not Node).
  async js(expr) { try { log(JSON.stringify(await page.evaluate(expr))); } catch (e) { log('ERROR', e.message); } },
  async text(sel) { log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null)); },
  // This app has no native <select> — a picker's rows are `role="option"`
  // buttons in the open Menu panel (menu.tsx), not <option> tags, and they
  // carry no data-value: read `label` off textContent plus the two real
  // attributes the markup has, `aria-selected` and `disabled`. `sel` scopes
  // the search to one element (e.g. the `[data-slot="select"]` wrapper); the
  // menu must already be open (`click [data-menu-trigger]`) or this returns [].
  async options(sel) { log(JSON.stringify(await page.evaluate((s) => { const root = document.querySelector(s); if (!root) return null; return [...root.querySelectorAll('[role="option"]')].map((o) => ({ label: o.textContent.trim(), selected: o.getAttribute('aria-selected') === 'true', disabled: o.hasAttribute('disabled') })); }, sel))); },
  async quit() { try { await browser?.close(); } catch {} try { daemon?.kill('SIGTERM'); } catch {} staticSrv?.close(); },
  help() { log('commands:', Object.keys(COMMANDS).join(', ')); },
};

// Read the raw fd so Chromium/Node don't fight over the REPL's stdin.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  const sp = trimmed.indexOf(' ');
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const arg = sp === -1 ? '' : trimmed.slice(sp + 1);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) { log('unknown:', cmd, '— try: help'); return rl.prompt(); }
  try { await fn.call(COMMANDS, arg); } catch (e) { log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });
log('geniro run-desktop driver — "help" for commands, "launch" to start');
rl.prompt();
