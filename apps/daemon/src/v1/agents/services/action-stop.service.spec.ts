import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import {
  clearSecrets,
  redactSecrets,
  registerSecret,
} from '../../diagnostics/utils/redact';
import type { ActionSpec } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { ProcessUsageRow } from '../utils/process-usage';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  type ScannedProcess,
} from '../utils/run-process-scan';
import { ActionStopService } from './action-stop.service';
import { RunProcessAttribution } from './run-process-attribution.service';
import {
  RunProcessReaper,
  type RunProcessReaperOptions,
} from './run-process-reaper.service';

const RUN = 'run-1111';
const OWNER = 'aaaaaaaaaaaaaaaa';
const SELF = 900;
const UID = 501;
const SERVER = 'python3 -m http.server 8765';

const tag = (runId = RUN): string =>
  `${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${OWNER}`;

function row(
  pid: number,
  ppid: number,
  args: string,
  pgid: number,
  overrides: Partial<ScannedProcess> = {},
): ScannedProcess & { pgid: number } {
  return {
    pid,
    ppid,
    uid: UID,
    tty: null,
    startedAt: pid * 10,
    args,
    env: '',
    pgid,
    ...overrides,
  };
}

/**
 * The chat's live CLI (10) leading a group its MCP server (11) shares, a
 * command it backgrounded in a group of its own (12, the shell wrapper, and 13,
 * the server it runs), and another chat's process (20).
 */
function table(
  overrides: Record<number, Partial<ScannedProcess>> = {},
): (ScannedProcess & { pgid: number })[] {
  return [
    row(10, 1, 'claude', 10, { env: tag(), ...overrides[10] }),
    row(11, 10, 'node mcp-server.js', 10, overrides[11]),
    row(12, 10, `/bin/bash -c ${SERVER}`, 12, overrides[12]),
    row(13, 12, SERVER, 12, overrides[13]),
    row(20, 1, 'node other.js', 20, { env: tag('run-2222'), ...overrides[20] }),
  ];
}

const shellOpen = (
  id: string,
  workId: string,
  nodeId: string | null = null,
  callId: string | null = null,
) => ({
  kind: 'shell_open',
  payload: JSON.stringify({ id, workId, callId }),
  nodeId,
});

function setup(
  options: {
    rows?: (ScannedProcess & { pgid: number })[];
    shells?: ReturnType<typeof shellOpen>[];
    /** Launching calls, oldest first, as `toolCallsByIds` returns them. */
    calls?: {
      id: string;
      command?: string;
      nodeId?: string | null;
      callId?: string;
      parentToolUseId?: string;
    }[];
    reaper?: RunProcessReaperOptions;
  } = {},
): { service: ActionStopService; signals: [number, NodeJS.Signals][] } {
  const rows = options.rows ?? table();
  const signals: [number, NodeJS.Signals][] = [];
  const reaper = new RunProcessReaper(
    new RunProcessAttribution(OWNER, {
      scan: () => Promise.resolve(rows),
      selfPid: SELF,
      uid: UID,
    }),
    {
      signal: (pid, sig) => signals.push([pid, sig]),
      startTimes: (pids) =>
        Promise.resolve(new Map(pids.map((pid) => [pid, pid * 10]))),
      wait: () => Promise.resolve(),
      logger: { log: () => undefined, warn: () => undefined },
      selfPid: SELF,
      processRoots: () => [10],
      listUsage: () =>
        Promise.resolve(
          rows.map((process): ProcessUsageRow => ({
            pid: process.pid,
            ppid: process.ppid,
            args: process.args,
            pgid: process.pgid,
            cpuPercent: 0,
            rssBytes: 0,
            elapsedSeconds: null,
            comm: null,
          })),
        ),
      ...options.reaper,
    },
  );
  const calls = options.calls ?? [{ id: 'call-1', command: SERVER }];
  const itemDao = {
    shellRows: () =>
      Promise.resolve(options.shells ?? [shellOpen('call-1', 'bg1')]),
    toolCallsByIds: (_runId: string, ids: readonly string[]) =>
      Promise.resolve(
        calls
          .filter((call) => ids.includes(call.id))
          .map((call) => ({
            payload: JSON.stringify({
              id: call.id,
              name: 'Bash',
              ...(call.command === undefined
                ? {}
                : { input: { command: call.command } }),
              ...(call.callId === undefined ? {} : { callId: call.callId }),
              ...(call.parentToolUseId === undefined
                ? {}
                : { parentToolUseId: call.parentToolUseId }),
            }),
            nodeId: call.nodeId ?? null,
            createdAt: new Date(0),
          })),
      ),
  } as unknown as ItemDao;
  return {
    service: new ActionStopService(
      { fork: () => ({}) } as unknown as EntityManager,
      itemDao,
      reaper,
    ),
    signals,
  };
}

const at = (pid: number): string => new Date(pid * 10).toISOString();

describe('ActionStopService.resolve', () => {
  it('publish refuses a pid not attributed to this run and records start time for one that is', async () => {
    const { service } = setup();

    expect(await service.resolve(RUN, null, { pid: 13 })).toEqual({
      targets: [{ pid: 13, startedAt: at(13), command: SERVER }],
    });
    // Only the named process: what it starts is stopped at the press.
    expect(await service.resolve(RUN, null, { pid: 12 })).toEqual({
      targets: [
        { pid: 12, startedAt: at(12), command: `/bin/bash -c ${SERVER}` },
      ],
    });
    for (const pid of [20, 10, 11, 4242]) {
      expect(await service.resolve(RUN, null, { pid })).toEqual({
        reason: expect.stringContaining(
          `pid ${pid} is not a running process of this chat`,
        ),
      });
    }
  });

  it('resolves a shell id to the top process running its command, by work id or call id', async () => {
    const { service } = setup();
    const expected = {
      shellId: 'bg1',
      targets: [
        { pid: 12, startedAt: at(12), command: `/bin/bash -c ${SERVER}` },
      ],
    };
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toEqual(
      expected,
    );
    expect(await service.resolve(RUN, null, { shell: 'call-1' })).toEqual(
      expected,
    );
  });

  it('unknown shell id lists running shells by id alone', async () => {
    const { service } = setup({
      shells: [
        shellOpen('call-1', 'bg1'),
        shellOpen('call-2', 'bg2'),
        shellOpen('call-9', 'bg9', 'other-node'),
      ],
    });
    const answer = await service.resolve(RUN, null, { shell: 'nope' });
    expect(answer).toEqual({
      reason: expect.stringContaining('Running: bg1, bg2. '),
    });
    expect(JSON.stringify(answer)).not.toContain('bg9');
    expect(JSON.stringify(answer)).not.toContain(SERVER);
    expect(JSON.stringify(answer)).toContain('stop.pid');
  });

  it('refuses a shell whose command matches more than one separate process', async () => {
    // A second shell of the run runs the very same server.
    const { service } = setup({
      rows: [
        ...table(),
        row(14, 10, `/bin/bash -c ${SERVER}`, 14),
        row(15, 14, SERVER, 14),
      ],
    });
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toEqual({
      reason: expect.stringContaining(
        'the command of "bg1" matches 2 separate processes',
      ),
    });
  });

  it("reads the command from this node's newest call by that id", async () => {
    const { service } = setup({
      calls: [
        { id: 'call-1', command: 'pnpm old-server' },
        { id: 'call-1', command: SERVER },
        { id: 'call-1', command: 'pnpm other-node', nodeId: 'reviewer' },
      ],
    });
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toMatchObject({
      targets: [{ pid: 12 }],
    });
  });

  it('pairs a shell with the call of its own conversation, never a reused id elsewhere', async () => {
    // ACP numbers calls per session: another call of this node and a
    // delegate's call reuse the id after the shell was launched.
    const { service } = setup({
      shells: [shellOpen('call-1', 'bg1', null, 'call-A')],
      calls: [
        { id: 'call-1', command: SERVER, callId: 'call-A' },
        { id: 'call-1', command: 'pnpm other-server', callId: 'call-B' },
        {
          id: 'call-1',
          command: 'pnpm delegate-server',
          callId: 'call-A',
          parentToolUseId: 'task-1',
        },
      ],
    });
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toMatchObject({
      targets: [{ pid: 12 }],
    });
  });

  it('refuses a shell id that names shells of more than one conversation', async () => {
    // cursor's work id is its call id, which each ACP session restarts.
    const { service } = setup({
      shells: [
        shellOpen('call-1', 'call-1', null, 'call-A'),
        shellOpen('call-1', 'call-1', null, 'call-B'),
      ],
      calls: [
        { id: 'call-1', command: SERVER, callId: 'call-A' },
        { id: 'call-1', command: SERVER, callId: 'call-B' },
      ],
    });
    expect(await service.resolve(RUN, null, { shell: 'call-1' })).toEqual({
      reason: expect.stringContaining(
        '"call-1" names background commands in more than one conversation',
      ),
    });
  });

  it('refuses a shell whose launching call cannot be read', async () => {
    const { service } = setup({ calls: [] });
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toEqual({
      reason: expect.stringContaining(
        'geniro cannot tell which process "bg1" is',
      ),
    });
  });

  it('refuses a shell whose command runs no process it may stop', async () => {
    const { service } = setup({
      calls: [{ id: 'call-1', command: 'pnpm dev --port 9999' }],
    });
    expect(await service.resolve(RUN, null, { shell: 'bg1' })).toEqual({
      reason: expect.stringContaining('"bg1" runs no process of this chat'),
    });
  });

  it('masks a registered secret in the command it records', async () => {
    registerSecret('hunter2-secret', 'a test token');
    try {
      const { service } = setup({
        rows: table({ 13: { args: `${SERVER} --token hunter2-secret` } }),
      });
      const answer = await service.resolve(RUN, null, { pid: 13 });
      expect(answer).toEqual({
        targets: [
          {
            pid: 13,
            startedAt: at(13),
            command: `${SERVER} --token ${redactSecrets('hunter2-secret')}`,
          },
        ],
      });
      expect(JSON.stringify(answer)).not.toContain('hunter2-secret');
    } finally {
      clearSecrets();
    }
  });

  it('masks env assignments in a recorded command', async () => {
    const { service } = setup({
      rows: table({
        12: { args: `/bin/bash -c API_TOKEN=abc123 ${SERVER}` },
      }),
    });
    expect(await service.resolve(RUN, null, { pid: 12 })).toMatchObject({
      targets: [{ command: `/bin/bash -c API_TOKEN=… ${SERVER}` }],
    });
  });

  it('records a command as one line of at most 200 characters', async () => {
    const { service } = setup({
      rows: table({ 13: { args: `${SERVER}   --dir\t${'x'.repeat(300)}` } }),
    });
    const answer = await service.resolve(RUN, null, { pid: 13 });
    const command =
      'targets' in answer ? (answer.targets?.[0]?.command ?? '') : '';
    expect(command).toHaveLength(200);
    expect(command.startsWith(`${SERVER} --dir xxx`)).toBe(true);
    expect(command.endsWith('…')).toBe(true);
  });

  it('answers the table refusal instead of throwing', async () => {
    const { service } = setup({
      reaper: { listUsage: () => Promise.resolve(null) },
    });
    expect(await service.resolve(RUN, null, { pid: 13 })).toEqual({
      reason: 'could not safely read the process table; try again',
    });
  });
});

describe('ActionStopService.stop', () => {
  const spec = (pids: number[]): ActionSpec => ({
    kind: 'stop',
    targets: pids.map((pid) => ({ pid, startedAt: at(pid), command: 'x' })),
  });

  it('stops the recorded processes', async () => {
    const { service, signals } = setup();
    expect(await service.stop(RUN, spec([13]))).toEqual({ state: 'stopped' });
    expect(signals).toEqual([
      [13, 'SIGTERM'],
      [13, 'SIGKILL'],
    ]);
  });

  it('says already stopped when every target had exited', async () => {
    const { service, signals } = setup({
      reaper: { startTimes: () => Promise.resolve(new Map()) },
    });
    expect(await service.stop(RUN, spec([12, 13]))).toEqual({
      state: 'stopped',
      alreadyStopped: true,
    });
    expect(signals).toEqual([]);
  });

  it('records a refusal as a failed press, stopping nothing', async () => {
    const { service, signals } = setup({
      rows: table({ 13: { ppid: 1, env: null } }),
    });
    expect(await service.stop(RUN, spec([12, 13]))).toEqual({
      state: 'failed',
      error: 'pid 13 is no longer a process this thread may stop; stopped none',
    });
    expect(signals).toEqual([]);
  });

  it('fails a stop whose recorded start time cannot be read', async () => {
    const { service, signals } = setup();
    expect(
      await service.stop(RUN, {
        kind: 'stop',
        targets: [{ pid: 13, startedAt: 'yesterday', command: 'x' }],
      }),
    ).toEqual({
      state: 'failed',
      error: 'this action names no process geniro can confirm',
    });
    expect(signals).toEqual([]);
  });
});
