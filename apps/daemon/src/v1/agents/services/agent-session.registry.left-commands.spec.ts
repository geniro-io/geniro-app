import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import { scanPlainTable } from '../utils/run-process-scan';
import { defaultSpawn, type SpawnFn } from '../utils/spawn-cli';
import { SessionfulAdapter } from './__tests__/sessionful-adapter';
import { AgentSessionRegistry } from './agent-session.registry';
import { RunProcessAttribution } from './run-process-attribution.service';
import { createRunProcessReaper } from './run-process-reaper.service';

/** Unique per test process, so the table reads below never match a stranger. */
const SECONDS = String(60_000 + (process.pid % 9_000));
const COMMAND = `sleep ${SECONDS}; :`;
const MCP_MARK = `mcp-double ${SECONDS}`;

/**
 * A REAL agent CLI double, run by node through `defaultSpawn` as production
 * spawns a CLI. It does what claude, codex and cursor-agent were measured doing
 * on macOS: it starts the agent's background command in a NEW session — so no
 * signal to the CLI's own group reaches it — under `/bin/sh`, a platform binary
 * whose environment the kernel withholds (so the run tag cannot be read off it
 * once its parent is gone), and it keeps an MCP server double as an ordinary
 * child in its own group. Then it reports the command running, ends its turn
 * and waits to be killed.
 */
const FAKE_CLI = `
const { spawn } = require('node:child_process');
spawn('/bin/sh', ['-c', ${JSON.stringify(COMMAND)}], { detached: true, stdio: 'ignore' });
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); // ${MCP_MARK}'], { stdio: 'ignore' });
const say = (row) => process.stdout.write(JSON.stringify(row) + '\\n');
say({ run: 't1', cmd: ${JSON.stringify(COMMAND)} });
say({ work: 'b1', call: 't1' });
say({ done: true });
setInterval(() => {}, 1000);
`;

const spawnFakeCli: SpawnFn = (_command, _args, options) =>
  defaultSpawn(process.execPath, ['-e', FAKE_CLI], {
    cwd: options.cwd,
    // The daemon's tests run under Electron's node, which runs a script only
    // with this set; the adapter's env builder strips it from every agent.
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
  });

/** The live rows whose command line contains `needle`. */
function running(needle: string): { pid: number; args: string }[] {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,args='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), args: match[2] ?? '' }))
    .filter((row) => row.args.includes(needle) && row.pid !== process.pid);
}

/**
 * The command's own processes: `/bin/sh` and the `sleep` it runs. Matched on
 * the whole line, since the fake CLI's `-e` script carries the same text.
 */
const isCommand = (args: string): boolean =>
  args === `/bin/sh -c ${COMMAND}` || args === `sleep ${SECONDS}`;
const commandRows = () =>
  running(`sleep ${SECONDS}`).filter((row) => isCommand(row.args));

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await sleep(50);
  }
}

const noop = (_event: AgentEvent): void => {};

describe('a CLI that dies without stopping its background commands', () => {
  it('has the commands it reported stopped, and its MCP servers left running', async () => {
    const registry = new AgentSessionRegistry();
    // Wired as production wires it: the registry tells the reaper.
    createRunProcessReaper(new RunProcessAttribution('test-owner'), registry);
    // The real table, read as production reads it; noted once a reading has
    // seen the command, so the CLI is killed only after a recording exists.
    let readTheCommand = false;
    const adapter = new SessionfulAdapter(spawnFakeCli, {
      listProcessGroupsFn: async () => {
        const rows = await scanPlainTable();
        readTheCommand ||= rows?.some((row) => isCommand(row.args)) ?? false;
        return rows;
      },
    });
    try {
      registry.startTurn(
        'run-1',
        adapter,
        { prompt: 'p', cwd: tmpdir() },
        noop,
      );
      // `sleep` itself is the one whose line does NOT carry the reported
      // command — only its `/bin/sh` parent's does.
      await waitFor(
        () => commandRows().length === 2 && running(MCP_MARK).length >= 1,
        10_000,
      );
      expect(commandRows()).toHaveLength(2);
      // A command is in hand once the session has recorded where it runs; a
      // CLI dying before that is outside what this guards.
      await waitFor(() => readTheCommand, 5_000);
      // The session files a reading just after it returns.
      await sleep(50);
      expect(readTheCommand).toBe(true);
      const cli = registry.peek('run-1')?.pid;
      expect(cli).toEqual(expect.any(Number));

      // A crash, an OOM kill, a Force Quit: the CLI's own shutdown never runs.
      process.kill(cli as number, 'SIGKILL');
      await waitFor(() => commandRows().length === 0, 10_000);

      expect(commandRows().map((row) => row.args)).toEqual([]);
      expect(running(MCP_MARK)).toHaveLength(1);
    } finally {
      for (const row of [
        ...running(`sleep ${SECONDS}`),
        ...running(MCP_MARK),
      ]) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }, 30_000);
});
