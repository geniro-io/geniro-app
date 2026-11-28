import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const SLOT_COUNT = 10;
export const KILL_CAP = 60;
export const STANDS_ROOT = join(tmpdir(), 'geniro-stands');

export function slotPorts(slot) {
  return { daemon: 47625 + 10 * slot, cdp: 9333 + 10 * slot };
}

export function pickSlot(hasListener) {
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const ports = slotPorts(slot);
    if (!hasListener(ports.daemon) && !hasListener(ports.cdp)) {
      return slot;
    }
  }
  return null;
}

export function parseSlot(value) {
  if (value === undefined) {
    return undefined;
  }
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new Error(
      `--slot must be an integer 0-${SLOT_COUNT - 1}, got "${value}"`,
    );
  }
  return slot;
}

export function realProfileDirs(home = homedir()) {
  return [
    join(home, 'Library', 'Application Support', 'Geniro'),
    join(home, '.geniro'),
  ];
}

export function isRealProfile(dir, home = homedir()) {
  const target = resolve(dir);
  return realProfileDirs(home).some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}

/**
 * Refuses anything that is not a LINKED git worktree: the main checkout's
 * cwd list holds the user's own editors and shells, so a kill list built from
 * it is never safe.
 */
export function checkPathShape(path, home) {
  if (!path || !isAbsolute(path)) {
    return `worktree path must be absolute, got "${path ?? ''}"`;
  }
  const target = resolve(path);
  if (target === '/' || target === resolve(home)) {
    return `refusing "${target}": not a worktree`;
  }
  return null;
}

export function checkWorktreeFacts({
  path,
  home,
  toplevel,
  gitDir,
  commonDir,
}) {
  const shape = checkPathShape(path, home);
  if (shape) {
    return shape;
  }
  const target = resolve(path);
  if (toplevel === null) {
    return `"${target}" is not inside a git checkout`;
  }
  if (resolve(toplevel) !== target) {
    return `"${target}" is not a worktree root (its root is "${toplevel}")`;
  }
  if (resolve(target, gitDir) === resolve(target, commonDir)) {
    return `"${target}" is the main checkout, not a linked worktree`;
  }
  return null;
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function resolveWorktree(path) {
  const shape = checkPathShape(path, homedir());
  if (shape) {
    throw new Error(shape);
  }
  const target = resolve(path);
  if (!existsSync(target)) {
    throw new Error(`"${target}" does not exist`);
  }
  const error = checkWorktreeFacts({
    path: target,
    home: homedir(),
    toplevel: git(target, ['rev-parse', '--show-toplevel']),
    gitDir: git(target, ['rev-parse', '--git-dir']) ?? '',
    commonDir: git(target, ['rev-parse', '--git-common-dir']) ?? '',
  });
  if (error) {
    throw new Error(error);
  }
  return target;
}

export function worktreeKey(worktree) {
  const name = basename(worktree)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 40);
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

export function standStatePath(worktree) {
  return join(STANDS_ROOT, `${worktreeKey(worktree)}.json`);
}

export function readStandState(worktree) {
  try {
    return JSON.parse(readFileSync(standStatePath(worktree), 'utf8'));
  } catch {
    return null;
  }
}

export function readAllStandStates() {
  try {
    return readdirSync(STANDS_ROOT)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(STANDS_ROOT, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A recorded stand is alive while its parent pid still runs electron-vite. */
export function isStandAlive(state, table) {
  const parent = table.get(state?.pids?.parent);
  return (
    parent !== undefined &&
    parent.command.includes('electron-vite') &&
    parent.command.includes(state.worktree)
  );
}

export function defaultProfile(worktree, slot) {
  return join(STANDS_ROOT, `${worktreeKey(worktree)}-slot${slot}`);
}

export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

export function parseViteUrl(log) {
  const match = stripAnsi(log).match(
    /Local:\s+(http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/,
  );
  return match ? match[1] : null;
}

export function listenerPids(port) {
  try {
    return execFileSync(
      'lsof',
      ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

export const hasListener = (port) => listenerPids(port).length > 0;

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/;

export function parsePsTable(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(PS_LINE);
    if (match) {
      const [, pid, ppid, pgid, uid, started, command] = match;
      table.set(Number(pid), {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        uid: Number(uid),
        started,
        command: command.trim(),
      });
    }
  }
  return table;
}

export function readProcessTable() {
  return parsePsTable(
    execFileSync(
      'ps',
      ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,command='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
}

export function parseLsofCwd(text, worktree) {
  const pids = new Set();
  let pid = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== null) {
      const dir = line.slice(1).replace(/ \(deleted\)$/, '');
      if (dir === worktree || dir.startsWith(`${worktree}/`)) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

export function cwdPids(worktree) {
  let text = '';
  try {
    text = execFileSync(
      'lsof',
      ['-a', '-d', 'cwd', '-u', String(process.getuid()), '-Fpn'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    text = error.stdout ?? '';
  }
  return parseLsofCwd(text, worktree);
}

export function descendantsOf(table, roots) {
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) {
      children.set(proc.ppid, []);
    }
    children.get(proc.ppid).push(proc.pid);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid) || !table.has(pid)) {
      continue;
    }
    seen.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return seen;
}

export function ancestorsOf(table, pid) {
  const chain = new Set();
  let current = pid;
  while (current > 0 && !chain.has(current)) {
    chain.add(current);
    current = table.get(current)?.ppid ?? 0;
  }
  return chain;
}

/**
 * The caller's own processes, never to be signalled: its ancestors and the
 * rest of its pipeline, which shares its process group (the ps and lsof it
 * runs included). A detached child it spawned leads a group of its own.
 */
export function callerProcesses(table, pid) {
  const keep = ancestorsOf(table, pid);
  const pgid = table.get(pid)?.pgid;
  if (pgid !== undefined) {
    for (const proc of table.values()) {
      if (proc.pgid === pgid) {
        keep.add(proc.pid);
      }
    }
  }
  return keep;
}

const PROTECTED_PATH =
  /^(\/Applications\/|\/System\/|\/usr\/libexec\/|\/Library\/Apple\/)/;
const PROTECTED_PROGRAM =
  /(^|\/)(claude|cursor-agent|codex|colima|lima|limactl|docker|qemu-system-[\w-]+|com\.docker\.[\w.-]+)( |$)|\/claude\/versions\/|\/claude-code\/|\/@openai\/codex\/|\/cursor-agent\/|Geniro\.app\/|\/\.colima\/|\/\.lima\//;

export function protectedReason(proc, { uid, keep }) {
  if (proc.pid <= 1) {
    return 'system process';
  }
  if (keep.has(proc.pid)) {
    return 'the caller: this script, its pipeline or an ancestor';
  }
  if (proc.uid !== uid) {
    return 'owned by another user';
  }
  if (PROTECTED_PATH.test(proc.command)) {
    return 'system or installed application';
  }
  if (PROTECTED_PROGRAM.test(proc.command)) {
    return 'agent CLI, Geniro.app or container runtime';
  }
  return null;
}

function protectedAncestor(table, pid, options) {
  const seen = new Set();
  let current = table.get(pid)?.ppid ?? 0;
  while (current > 1 && !seen.has(current) && table.has(current)) {
    seen.add(current);
    const reason = protectedReason(table.get(current), options);
    if (reason) {
      return `under a protected process (${current}: ${reason})`;
    }
    current = table.get(current).ppid;
  }
  return null;
}

/**
 * Splits the candidates and their descendants into the ones to signal and
 * the ones kept, with the reason each was kept. The walk never passes a kept
 * process, so an agent CLI's shells and servers stay with it; a candidate
 * found by its cwd is kept too when any ancestor is protected, unless the
 * caller vouches for the roots (it spawned them itself).
 */
export function buildKillList(
  table,
  candidates,
  { uid, keep, trustRoots = false },
) {
  const options = { uid, keep };
  const kill = [];
  const kept = [];
  const seen = new Set();
  const queue = candidates.filter((pid) => table.has(pid));
  const roots = new Set(queue);
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) {
      children.set(proc.ppid, []);
    }
    children.get(proc.ppid).push(proc.pid);
  }
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const proc = table.get(pid);
    const reason =
      protectedReason(proc, options) ??
      (roots.has(pid) && !trustRoots
        ? protectedAncestor(table, pid, options)
        : null);
    if (reason) {
      kept.push({ ...proc, reason });
      continue;
    }
    kill.push(proc);
    queue.push(...(children.get(pid) ?? []));
  }
  const byPid = (x, y) => x.pid - y.pid;
  return {
    kill: kill.sort(byPid),
    kept: kept.sort(byPid),
    overCap: kill.length > KILL_CAP,
  };
}

export function splitSeedList(list) {
  const names = (list ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    rows: names
      .filter((name) => name !== LIVE_SCENARIO && name !== 'fixtures')
      .join(','),
    live: names.includes(LIVE_SCENARIO) || names.includes('all'),
  };
}

export const LIVE_SCENARIO = 'working-threads';

export function sameProcess(table, proc) {
  const now = table.get(proc.pid);
  return now !== undefined && now.started === proc.started;
}

export function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  delete env.GENIRO_RUN_ID;
  delete env.GENIRO_RUN_OWNER;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

export async function fetchOk(url, timeoutMs = 5000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export const CDP_TIMEOUT_MS = 15_000;

export const isRendererTarget = (target) =>
  target.type === 'page' &&
  (target.url.startsWith('http://localhost:') ||
    target.url.startsWith('http://127.0.0.1:'));

export async function pageTargets(port) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      `no CDP endpoint answers on port ${port}; is the stand up?`,
    );
  }
  return (await response.json()).filter((target) => target.type === 'page');
}

/** One websocket session on a page target; every call fails after 15 s. */
export async function cdpSession(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = () =>
      fail(new Error(`cannot open ${target.webSocketDebuggerUrl}`));
    setTimeout(
      () => fail(new Error('websocket: no answer in 15s')),
      CDP_TIMEOUT_MS,
    ).unref();
  });
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const callId = ++id;
      pending.set(callId, (message) =>
        message.error
          ? fail(new Error(`${method}: ${message.error.message}`))
          : done(message.result),
      );
      ws.send(JSON.stringify({ id: callId, method, params }));
      setTimeout(
        () =>
          fail(new Error(`${method}: no answer in ${CDP_TIMEOUT_MS / 1000}s`)),
        CDP_TIMEOUT_MS,
      ).unref();
    });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'evaluate failed',
      );
    }
    return result.result?.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

export async function closeBrowser(cdpPort, timeoutMs = 5000) {
  try {
    const version = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
    ).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.onopen = done;
      ws.onerror = fail;
      setTimeout(() => fail(new Error('open timeout')), timeoutMs).unref();
    });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await pause(200);
    ws.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * TERM, then KILL, only for the processes of the given list that are still
 * the same process (pid and start time) when the signal goes out.
 */
export async function signalList(
  list,
  { graceMs = 8000, log = () => {} } = {},
) {
  const alive = () => {
    const table = readProcessTable();
    return list.filter((proc) => sameProcess(table, proc));
  };
  const send = (procs, signal) => {
    for (const proc of procs) {
      try {
        process.kill(proc.pid, signal);
      } catch {
        // already gone
      }
    }
  };
  let left = alive();
  if (left.length > 0) {
    log(`TERM ${left.map((proc) => proc.pid).join(' ')}`);
    send(left, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while ((left = alive()).length > 0 && Date.now() < deadline) {
      await pause(250);
    }
  }
  if (left.length > 0) {
    log(`KILL ${left.map((proc) => proc.pid).join(' ')}`);
    send(left, 'SIGKILL');
    const deadline = Date.now() + 3000;
    while ((left = alive()).length > 0 && Date.now() < deadline) {
      await pause(250);
    }
  }
  return left;
}

export function formatProc(proc) {
  return `${String(proc.pid).padStart(7)} ${String(proc.ppid).padStart(7)}  ${proc.command.slice(0, 160)}`;
}
