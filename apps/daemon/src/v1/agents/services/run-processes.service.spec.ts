import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import type { KeptProcessRoot } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import type { ProcessUsageRow } from '../utils/process-usage';
import { callSessionKey, nodeSessionKey } from '../utils/session-keys';
import type { AgentSessionRegistry } from './agent-session.registry';
import { RunProcessesService } from './run-processes.service';

function row(
  pid: number,
  ppid: number,
  pgid: number,
  extra: Partial<ProcessUsageRow> = {},
): ProcessUsageRow {
  return {
    pid,
    ppid,
    pgid,
    args: `proc-${pid}`,
    comm: null,
    cpuPercent: 1.2,
    rssBytes: 1_000,
    elapsedSeconds: 60,
    ...extra,
  };
}

/** The daemon's own pid in these fixtures; its parent (10) is the app. */
const DAEMON = 20;

function build(
  roots: KeptProcessRoot[],
  rows: ProcessUsageRow[] | null,
  runExists = true,
): { service: RunProcessesService; listUsage: ReturnType<typeof vi.fn> } {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run-1' } : null),
    getAll: () =>
      Promise.resolve([
        { id: 'run-1', title: 'Fix the parser' },
        { id: 'run-2', title: null },
      ]),
  } as unknown as RunDao;
  const sessions = {
    processRoots: () => roots,
  } as unknown as AgentSessionRegistry;
  const listUsage = vi.fn(() => Promise.resolve(rows));
  return {
    service: new RunProcessesService(em, runDao, sessions, listUsage, DAEMON),
    listUsage,
  };
}

describe('RunProcessesService', () => {
  it('refuses a run that does not exist', async () => {
    const { service } = build([], [], false);
    await expect(service.read('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not read the process table for a run that holds no process', async () => {
    const { service, listUsage } = build([], []);
    const reading = await service.read('run-1');
    expect(listUsage).not.toHaveBeenCalled();
    expect(reading).toMatchObject({
      trees: [],
      processes: 0,
      unavailableReason: null,
    });
  });

  it('says so when `ps` could not be read, rather than reporting nothing running', async () => {
    const { service } = build(
      [{ key: 'run-1', agent: 'claude', cwd: '/p', pid: 100 }],
      null,
    );
    const reading = await service.read('run-1');
    expect(reading.trees).toEqual([]);
    expect(reading.unavailableReason).toMatch(/process table/);
  });

  it('builds one tree per kept CLI, labelled by whose it is, and totals them', async () => {
    const { service } = build(
      [
        {
          key: nodeSessionKey('run-1', 'qa'),
          agent: 'cursor-agent',
          cwd: '/p',
          pid: 100,
        },
        {
          key: callSessionKey('run-1', 'call-3'),
          agent: 'claude',
          cwd: '/q',
          pid: 200,
        },
      ],
      [
        row(100, 1, 100, { comm: 'cursor-agent', args: 'cursor-agent acp' }),
        row(101, 100, 100, { rssBytes: 4_000 }),
        row(200, 1, 200, { cpuPercent: 50 }),
        row(999, 1, 999),
      ],
    );
    const reading = await service.read('run-1');

    expect(reading.trees).toMatchObject([
      {
        nodeId: 'qa',
        conversationId: null,
        agentKind: 'cursor-agent',
        rootPid: 100,
        cpuPercent: 2.4,
        rssBytes: 5_000,
      },
      {
        nodeId: null,
        conversationId: 'call-3',
        agentKind: 'claude',
        rootPid: 200,
      },
    ]);
    expect(
      reading.trees[0]?.processes.map((p) => [p.pid, p.name, p.link]),
    ).toEqual([
      [100, 'cursor-agent', 'root'],
      [101, 'proc-101', 'child'],
    ]);
    expect(reading.processes).toBe(3);
    expect(reading.cpuPercent).toBe(52.4);
    expect(reading.rssBytes).toBe(6_000);
  });

  it('drops a CLI that ended between the registry read and the `ps` read', async () => {
    const { service } = build(
      [{ key: 'run-1', agent: 'claude', cwd: '/p', pid: 100 }],
      [row(999, 1, 999)],
    );
    expect((await service.read('run-1')).trees).toEqual([]);
  });

  it('masks a registered secret in a command line before it leaves the daemon', async () => {
    onTestFinished(clearSecrets);
    registerSecret('s3cr3t-token-value', 'test token');
    const { service } = build(
      [{ key: 'run-1', agent: 'claude', cwd: '/p', pid: 100 }],
      [row(100, 1, 100, { args: 'mcp-server --token s3cr3t-token-value' })],
    );
    const reading = await service.read('run-1');
    expect(reading.trees[0]?.processes[0]?.args).not.toContain(
      's3cr3t-token-value',
    );
  });
});

describe('RunProcessesService — the whole app, by thread', () => {
  // 10 is the app (Electron main), 20 the daemon under it, 30 the window's
  // renderer; 100 and 200 are two of run-1's agents, 300 is run-2's.
  const ROWS = [
    row(10, 1, 10, { rssBytes: 5_000, cpuPercent: 2 }),
    row(20, 10, 10, { rssBytes: 3_000 }),
    row(30, 10, 10, { rssBytes: 7_000 }),
    row(100, 20, 100, { rssBytes: 1_000 }),
    row(101, 100, 100, { rssBytes: 1_000 }),
    row(200, 20, 200, { rssBytes: 2_000 }),
    row(300, 20, 300, { rssBytes: 9_000, cpuPercent: 40 }),
    row(999, 1, 999, { rssBytes: 50_000 }),
  ];
  const ROOTS: KeptProcessRoot[] = [
    {
      key: nodeSessionKey('run-1', 'manager'),
      agent: 'claude',
      cwd: '/p',
      pid: 100,
    },
    {
      key: callSessionKey('run-1', 'call-2'),
      agent: 'cursor-agent',
      cwd: '/p',
      pid: 200,
    },
    { key: 'run-2', agent: 'claude', cwd: '/q', pid: 300 },
  ];

  it('folds every agent of a run into ONE thread, heaviest first, with its title', async () => {
    const { service } = build(ROOTS, ROWS);
    const reading = await service.readAll();
    expect(
      reading.threads.map((t) => [
        t.runId,
        t.title,
        t.agents,
        t.agentKinds,
        t.figures,
      ]),
    ).toEqual([
      [
        'run-2',
        null,
        1,
        ['claude'],
        { processes: 1, cpuPercent: 40, rssBytes: 9_000 },
      ],
      [
        'run-1',
        'Fix the parser',
        2,
        ['claude', 'cursor-agent'],
        { processes: 3, cpuPercent: 3.6, rssBytes: 4_000 },
      ],
    ]);
  });

  it('counts geniro as the app’s tree minus every thread, so nothing is counted twice', async () => {
    const { service } = build(ROOTS, ROWS);
    const reading = await service.readAll();
    // 10, 20, 30 — the stranger at 999 is nobody's.
    expect(reading.geniro).toEqual({
      processes: 3,
      cpuPercent: 4.4,
      rssBytes: 15_000,
    });
    expect(reading.total).toEqual({
      processes: 7,
      cpuPercent: 48,
      rssBytes: 28_000,
    });
  });

  it('falls back to the daemon’s own tree when launchd started it', async () => {
    const { service } = build(
      [],
      [row(20, 1, 20, { rssBytes: 3_000 }), row(21, 20, 20), row(10, 1, 10)],
    );
    expect((await service.readAll()).geniro?.processes).toBe(2);
  });

  it('says why when `ps` could not be read', async () => {
    const { service } = build(ROOTS, null);
    const reading = await service.readAll();
    expect(reading.geniro).toBeNull();
    expect(reading.unavailableReason).toMatch(/process table/);
  });
});
