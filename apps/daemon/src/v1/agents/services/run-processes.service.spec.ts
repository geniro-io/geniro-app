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

function build(
  roots: KeptProcessRoot[],
  rows: ProcessUsageRow[] | null,
  runExists = true,
): { service: RunProcessesService; listUsage: ReturnType<typeof vi.fn> } {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run-1' } : null),
  } as unknown as RunDao;
  const sessions = {
    processRoots: () => roots,
  } as unknown as AgentSessionRegistry;
  const listUsage = vi.fn(() => Promise.resolve(rows));
  return {
    service: new RunProcessesService(em, runDao, sessions, listUsage),
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
