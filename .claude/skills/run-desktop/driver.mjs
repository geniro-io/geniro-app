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

function findChromium() {
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux/chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('Chromium not found under /opt/pw-browsers — is Playwright installed in this container?');
}
function findClaude() {
  try { return execSync('command -v claude', { shell: '/bin/bash' }).toString().trim(); } catch { return null; }
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
function startDaemon() {
  return new Promise((resolve, reject) => {
    fs.rmSync(UD, { recursive: true, force: true });
    fs.mkdirSync(path.join(UD, 'workflows'), { recursive: true });
    const child = spawn(process.execPath, [DAEMON_MAIN], {
      env: { ...process.env, GENIRO_USER_DATA: UD, GENIRO_PORT: '0', NODE_ENV: 'production' },
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
  const claude = JSON.stringify(findClaude() || '/usr/bin/claude');
  return `window.geniro = {
    getStatus: async () => ({ onboardingComplete: true, daemon: { connected: true, handle: ${h} } }),
    getDaemonHandle: async () => (${h}),
    onDaemonRestarted: () => () => {},
    pickProjectFolder: async () => ${cwd}, pickAgentBinary: async () => null,
    getSettings: async () => ({ onboardingComplete: true, projectFolder: ${cwd}, recentFolders: [${cwd}], lastChatTarget: 'claude', cliPaths: {}, checkForUpdates: false }),
    updateSettings: async (p) => ({ onboardingComplete: true, projectFolder: ${cwd}, recentFolders: [${cwd}], lastChatTarget: 'claude', cliPaths: {}, checkForUpdates: false, ...p }),
    detectClis: async () => ([{ kind: 'claude', found: true, path: ${claude}, version: 'detected' }, { kind: 'cursor-agent', found: false, path: null, version: null }]),
    saveSecret: async () => {}, hasSecret: async () => false, deleteSecret: async () => {}, completeOnboarding: async () => {},
    pickWorkflowImport: async () => null, pickWorkflowExport: async () => null, checkForUpdates: async () => ({ status: 'dev', version: null, message: null }),
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
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox', '--disable-web-security', '--disable-gpu', '--force-color-profile=srgb'] });
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
  async send() { log('send →', await page.evaluate(() => { const b = document.querySelector('button[aria-label="Send"], button[aria-label="Start run"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'OK'; })); },
  async approve() { log('approve →', await clickByText('Approve')); },
  async deny() { log('deny →', await clickByText('Deny')); },
  async ss(name) { const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png'); await page.screenshot({ path: f }); log('screenshot:', f); },
  // Run an expression in the page (Playwright page.evaluate — page context, not Node).
  async js(expr) { try { log(JSON.stringify(await page.evaluate(expr))); } catch (e) { log('ERROR', e.message); } },
  async text(sel) { log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null)); },
  async options(sel) { log(JSON.stringify(await page.evaluate((s) => { const el = document.querySelector(s); return el ? [...el.querySelectorAll('option')].map((o) => ({ value: o.value, label: o.textContent })) : null; }, sel))); },
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
