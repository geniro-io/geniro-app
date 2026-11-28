#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildKillList,
  callerProcesses,
  checkPathShape,
  closeBrowser,
  cwdPids,
  descendantsOf,
  formatProc,
  listenerPids,
  parseSlot,
  pause,
  readProcessTable,
  readStandState,
  resolveWorktree,
  sameProcess,
  signalList,
  slotPorts,
  standStatePath,
} from './lib.mjs';

const USAGE =
  'usage: node scripts/stand/stop.mjs <absolute worktree path> [--slot k] [--dry-run]';

function targetWorktree(path) {
  if (path && existsSync(path)) {
    return { worktree: resolveWorktree(path), gone: false };
  }
  const error = checkPathShape(path, homedir());
  if (error) {
    throw new Error(error);
  }
  const target = resolve(path);
  if (readStandState(target) === null) {
    throw new Error(
      `"${target}" does not exist and no stand was booted from it`,
    );
  }
  return { worktree: target, gone: true };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      slot: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length !== 1) {
    throw new Error(USAGE);
  }
  const { worktree, gone } = targetWorktree(positionals[0]);
  const state = readStandState(worktree);
  const slot = parseSlot(values.slot) ?? state?.slot;
  const ports = slot === undefined ? null : slotPorts(slot);

  const table = readProcessTable();
  const own = new Set(cwdPids(worktree));
  const owned = descendantsOf(table, [...own]);
  const foreign = [];
  if (ports) {
    for (const port of [ports.daemon, ports.cdp]) {
      for (const pid of listenerPids(port)) {
        if (owned.has(pid)) {
          own.add(pid);
        } else {
          foreign.push({ port, pid, command: table.get(pid)?.command ?? '?' });
        }
      }
    }
  }
  const keep = callerProcesses(table, process.pid);
  const { kill, kept, overCap } = buildKillList(table, [...own], {
    uid: process.getuid(),
    keep,
  });

  console.log(`worktree ${worktree}${gone ? ' (folder gone)' : ''}`);
  console.log(
    ports
      ? `slot ${slot}: daemon port ${ports.daemon}, cdp port ${ports.cdp}`
      : 'slot unknown: cwd processes only (pass --slot)',
  );
  console.log(`to stop (${kill.length}):`);
  console.log('    pid    ppid  command');
  kill.forEach((proc) => console.log(formatProc(proc)));
  if (kept.length > 0) {
    console.log(`kept (${kept.length}):`);
    kept.forEach((proc) =>
      console.log(`${formatProc(proc)}  [${proc.reason}]`),
    );
  }
  foreign.forEach((entry) =>
    console.log(
      `port ${entry.port} is held by pid ${entry.pid} outside this worktree, left alone: ${entry.command.slice(0, 120)}`,
    ),
  );

  if (overCap) {
    throw new Error(
      `refusing: ${kill.length} processes is over the cap; the filter is wrong, nothing was signalled`,
    );
  }
  if (values['dry-run']) {
    console.log(
      JSON.stringify({
        dryRun: true,
        worktree,
        slot: slot ?? null,
        stop: kill.map((p) => p.pid),
        kept: kept.map((p) => p.pid),
      }),
    );
    return;
  }

  const cdpListener = ports
    ? listenerPids(ports.cdp).find((pid) =>
        kill.some((proc) => proc.pid === pid),
      )
    : undefined;
  if (cdpListener !== undefined && (await closeBrowser(ports.cdp))) {
    console.log('sent Browser.close');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const now = readProcessTable();
      if (!kill.some((proc) => sameProcess(now, proc))) {
        break;
      }
      await pause(250);
    }
  }
  const survivors = await signalList(kill, {
    log: (line) => console.log(line),
  });

  const busy = ports
    ? [ports.daemon, ports.cdp].filter((port) => listenerPids(port).length > 0)
    : [];
  if (
    survivors.length === 0 &&
    busy.length === 0 &&
    state?.worktree === worktree
  ) {
    rmSync(standStatePath(worktree), { force: true });
  }
  const result = {
    worktree,
    slot: slot ?? null,
    stopped: kill.map((p) => p.pid),
    kept: kept.map((p) => p.pid),
    survivors: survivors.map((p) => p.pid),
    portsBusy: busy,
  };
  console.log(JSON.stringify(result));
  if (survivors.length > 0 || busy.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
