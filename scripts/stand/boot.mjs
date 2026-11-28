#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  LIVE_SCENARIO,
  STANDS_ROOT,
  buildKillList,
  callerProcesses,
  cdpSession,
  defaultProfile,
  fetchOk,
  hasListener,
  isRealProfile,
  isRendererTarget,
  isStandAlive,
  listenerPids,
  pageTargets,
  parseSlot,
  parseViteUrl,
  pause,
  pickSlot,
  readAllStandStates,
  readProcessTable,
  readStandState,
  resolveWorktree,
  scrubbedEnv,
  signalList,
  slotPorts,
  splitSeedList,
  standStatePath,
} from './lib.mjs';

const USAGE = `usage: node scripts/stand/boot.mjs <absolute worktree path> [options]
  --slot k          port slot 0-9 (default: the lowest free one)
  --profile <dir>   scratch userData (default: ${STANDS_ROOT}/<worktree>-slot<k>)
  --fresh           wipe the default profile first
  --seed <list>     seed the profile: waiting-question, long-transcript, working-threads, all, or fixtures
                    (working-threads starts two live threads on the agent's light model once the stand is up)
  --working-agent <cli>  the CLI for working-threads: claude (default), codex or cursor-agent
  --timeout <s>     how long to wait for the stand (default 300)
  --no-build        skip building the daemon`;

const tail = (path, lines = 25) => {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
};

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function runLogged(command, args, { cwd, env, log, what }) {
  const fd = openSync(log, 'a');
  try {
    execFileSync(command, args, { cwd, env, stdio: ['ignore', fd, fd] });
  } catch {
    fail(`${what} failed`, { log, logTail: tail(log) });
  } finally {
    closeSync(fd);
  }
}

function checkInstall(worktree) {
  const electronVite = join(
    worktree,
    'node_modules',
    'electron-vite',
    'bin',
    'electron-vite.js',
  );
  const electron = join(
    worktree,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
  );
  if (!existsSync(electronVite) || !existsSync(electron)) {
    fail(`dependencies are missing in ${worktree}: run pnpm install there`);
  }
  try {
    execFileSync(
      electron,
      ['-e', "require('better-sqlite3')(':memory:').close()"],
      {
        cwd: join(worktree, 'apps', 'daemon'),
        env: { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        timeout: 60_000,
      },
    );
  } catch {
    fail(
      `better-sqlite3 does not load under Electron in ${worktree}: run pnpm rebuild:native there`,
    );
  }
  return { electronVite, electron };
}

function prepareProfile(worktree, slot, values) {
  const profile = values.profile
    ? resolve(values.profile)
    : defaultProfile(worktree, slot);
  if (isRealProfile(profile)) {
    fail(`refusing ${profile}: that is a real Geniro profile`);
  }
  const table = readProcessTable();
  const holder = readAllStandStates().find(
    (state) => state.profile === profile && isStandAlive(state, table),
  );
  if (holder) {
    fail(
      `profile ${profile} is in use by the stand of ${holder.worktree} (slot ${holder.slot}); stop it first`,
    );
  }
  if (values.fresh) {
    if (!profile.startsWith(`${STANDS_ROOT}/`)) {
      fail(`--fresh only wipes profiles under ${STANDS_ROOT}`);
    }
    rmSync(profile, { recursive: true, force: true });
  }
  mkdirSync(profile, { recursive: true });
  const settingsPath = join(profile, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...settings, onboardingComplete: true, remoteAccessEnabled: false }, null, 2)}\n`,
  );
  rmSync(join(profile, 'daemon.json'), { force: true });
  return profile;
}

async function waitFor(label, deadline, probe, parentPid, log) {
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    try {
      process.kill(parentPid, 0);
    } catch {
      fail(`the stand exited while waiting for ${label}`, {
        log,
        logTail: tail(log),
      });
    }
    await pause(1000);
  }
  fail(`timed out waiting for ${label}`, { log, logTail: tail(log) });
}

async function rendererEval(cdpPort, expression) {
  let session;
  try {
    const target = (await pageTargets(cdpPort)).find(isRendererTarget);
    if (!target) {
      return undefined;
    }
    session = await cdpSession(target);
    return await session.evaluate(expression);
  } catch {
    return undefined;
  } finally {
    session?.close();
  }
}

const WORKING_THREADS = 2;

async function daemonRequest(daemonUrl, token, method, path, body) {
  const response = await fetch(`${daemonUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    fail(
      `${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json();
}

/**
 * Rows cannot make a thread read as working after a boot (the daemon settles
 * orphaned runs and counts background work only from live events), so this
 * starts real turns on the CLI's light model that wait on a release file for
 * up to about 30 minutes. Touching the file ends them; so does the stand's
 * stop, whose daemon reaps its agents.
 */
async function startWorkingThreads(
  daemonUrl,
  token,
  profile,
  agentKind,
  deadline,
  parentPid,
  log,
) {
  const capabilities = await daemonRequest(
    daemonUrl,
    token,
    'GET',
    '/v1/capabilities',
  );
  const agent = capabilities.agents.find((entry) => entry.agent === agentKind);
  if (!agent) {
    fail(
      `--working-agent ${agentKind} is not an agent this daemon knows: ${capabilities.agents.map((entry) => entry.agent).join(', ')}`,
    );
  }
  const dir = join(profile, LIVE_SCENARIO);
  mkdirSync(dir, { recursive: true });
  const stopFile = join(dir, 'release');
  rmSync(stopFile, { force: true });
  const text = `Run exactly this command with the Bash tool, with a timeout of 600000 ms, and nothing else: until [ -f ${JSON.stringify(stopFile)} ]; do sleep 2; done\nWhen it returns, run it again, three times in all. Then reply with the single word: done.`;
  const runIds = [];
  for (let index = 1; index <= WORKING_THREADS; index++) {
    const run = await daemonRequest(daemonUrl, token, 'POST', '/v1/chats', {
      agentKind,
      cwd: dir,
      title: `Working thread ${index}`,
      ...(agent.lightModel ? { model: agent.lightModel } : {}),
      approval: 'auto',
    });
    await daemonRequest(
      daemonUrl,
      token,
      'POST',
      `/v1/chats/${run.id}/messages`,
      { text },
    );
    runIds.push(run.id);
  }
  await waitFor(
    'the working threads to run their command',
    deadline,
    async () => {
      const chats = await daemonRequest(daemonUrl, token, 'GET', '/v1/chats');
      let busy = 0;
      for (const id of runIds) {
        const status = chats.find((row) => row.id === id)?.status;
        const { items } = await daemonRequest(
          daemonUrl,
          token,
          'GET',
          `/v1/chats/${id}/items`,
        );
        const error = items.find((item) => item.kind === 'error');
        if (status !== 'running' || error) {
          fail(
            `working thread ${id} stopped (${status}): ${error?.payload?.message ?? 'no error row'}`,
          );
        }
        if (items.some((item) => item.kind === 'tool_call')) {
          busy += 1;
        }
      }
      return busy === runIds.length ? true : null;
    },
    parentPid,
    log,
  );
  return {
    agent: agentKind,
    model: agent.lightModel ?? null,
    runIds,
    stopFile,
  };
}

const ONBOARDED = `(async () => {
  if (!window.geniro?.getSettings) return 'not-ready';
  const settings = await window.geniro.getSettings();
  if (settings.onboardingComplete) return 'done';
  await window.geniro.updateSettings({ onboardingComplete: true });
  location.reload();
  return 'reloaded';
})()`;

/**
 * Stops what this boot spawned: the parent's tree, plus slot listeners left
 * orphaned when the parent died first (the slot was free before the spawn).
 */
async function stopWhatWeStarted(parentPid, ports) {
  const table = readProcessTable();
  const orphans = [ports.daemon, ports.cdp]
    .flatMap((port) => listenerPids(port))
    .filter((pid) => table.get(pid)?.ppid === 1);
  const { kill } = buildKillList(table, [parentPid, ...orphans], {
    uid: process.getuid(),
    keep: callerProcesses(table, process.pid),
    trustRoots: true,
  });
  await signalList(kill);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      slot: { type: 'string' },
      profile: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      seed: { type: 'string' },
      timeout: { type: 'string', default: '300' },
      'no-build': { type: 'boolean', default: false },
      'working-agent': { type: 'string', default: 'claude' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length !== 1) {
    fail(USAGE);
  }
  const worktree = resolveWorktree(positionals[0]);
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('--timeout must be a positive number of seconds');
  }

  if (values.profile && isRealProfile(values.profile)) {
    fail(`refusing ${resolve(values.profile)}: that is a real Geniro profile`);
  }

  const previous = readStandState(worktree);
  if (previous && isStandAlive(previous, readProcessTable())) {
    fail(
      `a stand from this worktree is already running (slot ${previous.slot}); stop it first: node scripts/stand/stop.mjs ${JSON.stringify(worktree)}`,
      { running: previous },
    );
  }

  const requested = parseSlot(values.slot);
  const slot = requested ?? pickSlot(hasListener);
  if (slot === null) {
    fail('every port slot 0-9 is taken');
  }
  const ports = slotPorts(slot);
  if (
    requested !== undefined &&
    (hasListener(ports.daemon) || hasListener(ports.cdp))
  ) {
    fail(
      `slot ${slot} is taken: port ${ports.daemon} or ${ports.cdp} has a listener`,
    );
  }

  const { electronVite } = checkInstall(worktree);
  const profile = prepareProfile(worktree, slot, values);
  const log = join(profile, 'stand.log');
  writeFileSync(log, '');
  const env = scrubbedEnv();

  if (!values['no-build']) {
    runLogged(
      process.execPath,
      [
        join(worktree, 'node_modules', 'turbo', 'bin', 'turbo'),
        'run',
        'build',
        '--filter=@geniro/daemon',
        '--output-logs=errors-only',
      ],
      {
        cwd: worktree,
        env,
        log: join(profile, 'build.log'),
        what: 'the daemon build',
      },
    );
  }
  if (!existsSync(join(worktree, 'apps', 'daemon', 'dist', 'main.js'))) {
    fail(
      'apps/daemon/dist/main.js is missing: run pnpm build in the worktree, or drop --no-build',
    );
  }
  const seed = splitSeedList(values.seed);
  if (values.seed) {
    const seedEnv = {
      ...env,
      GENIRO_USER_DATA: profile,
      GENIRO_SEED_CWD: worktree,
    };
    if (seed.rows) {
      seedEnv.GENIRO_SEED_SCENARIOS = seed.rows;
    }
    runLogged('pnpm', ['--filter', '@geniro/daemon', 'seed'], {
      cwd: worktree,
      env: seedEnv,
      log: join(profile, 'seed.log'),
      what: 'the seed',
    });
  }

  const out = openSync(log, 'a');
  const child = spawn(
    process.execPath,
    [electronVite, 'dev', '--', `--remote-debugging-port=${ports.cdp}`],
    {
      cwd: join(worktree, 'apps', 'ui'),
      env: {
        ...env,
        GENIRO_UI_USER_DATA: profile,
        GENIRO_USER_DATA: profile,
        GENIRO_PORT: String(ports.daemon),
      },
      detached: true,
      stdio: ['ignore', out, out],
    },
  );
  child.unref();
  closeSync(out);
  const parentPid = child.pid;

  try {
    const deadline = Date.now() + timeoutMs;
    const daemonUrl = `http://127.0.0.1:${ports.daemon}`;
    await waitFor(
      'the daemon on /health/check',
      deadline,
      () => fetchOk(`${daemonUrl}/health/check`),
      parentPid,
      log,
    );
    const pidfile = join(profile, 'daemon.json');
    const daemon = await waitFor(
      'daemon.json',
      deadline,
      () => {
        try {
          const record = JSON.parse(readFileSync(pidfile, 'utf8'));
          return record.port === ports.daemon ? record : null;
        } catch {
          return null;
        }
      },
      parentPid,
      log,
    );
    const viteUrl = await waitFor(
      'the vite URL',
      deadline,
      async () => {
        const url = parseViteUrl(readFileSync(log, 'utf8'));
        return url && (await fetchOk(url)) ? url : null;
      },
      parentPid,
      log,
    );
    const electronPid = await waitFor(
      'the CDP port',
      deadline,
      async () => {
        const pid = listenerPids(ports.cdp)[0];
        return pid &&
          (await fetchOk(`http://127.0.0.1:${ports.cdp}/json/version`))
          ? pid
          : null;
      },
      parentPid,
      log,
    );
    await waitFor(
      'the renderer',
      deadline,
      async () => {
        const state = await rendererEval(ports.cdp, ONBOARDED);
        return state === 'done' ? state : null;
      },
      parentPid,
      log,
    );

    const workingThreads = seed.live
      ? await startWorkingThreads(
          daemonUrl,
          daemon.token,
          profile,
          values['working-agent'],
          deadline,
          parentPid,
          log,
        )
      : null;

    const stand = {
      slot,
      worktree,
      profile,
      log,
      pids: { parent: parentPid, electron: electronPid, daemon: daemon.pid },
      ports: {
        daemon: ports.daemon,
        cdp: ports.cdp,
        vite: Number(new URL(viteUrl).port),
      },
      urls: {
        vite: viteUrl,
        daemon: daemonUrl,
        health: `${daemonUrl}/health/check`,
      },
      daemonJson: pidfile,
      seeded: values.seed ?? null,
      workingThreads,
      startedAt: new Date().toISOString(),
    };
    mkdirSync(STANDS_ROOT, { recursive: true });
    writeFileSync(
      standStatePath(worktree),
      `${JSON.stringify(stand, null, 2)}\n`,
    );
    console.log(JSON.stringify(stand));
  } catch (error) {
    await stopWhatWeStarted(parentPid, ports);
    throw error;
  }
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error?.details ?? {}),
    }),
  );
  process.exitCode = 1;
});
