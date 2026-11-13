import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { ItemDao } from '../dao/item.dao';
import { monitorRowEntry, monitorRowPayload } from '../utils/monitor-text';
import { MonitorBroker } from './monitor.broker';
import { MonitorRegistry } from './monitor.registry';
import { ProcessRegistry } from './process-registry';

const startRow = (
  id: string,
): Pick<Item, 'runId' | 'memberId' | 'seq' | 'payload'> => ({
  runId: 'run-1',
  memberId: 'agent',
  seq: Number(id.slice(1)),
  payload: JSON.stringify(
    monitorRowPayload(
      [
        monitorRowEntry(
          { id, description: 'CI', batch: { lines: [], omitted: 0 } },
          'start',
        ),
      ],
      null,
      false,
    ),
  ),
});

describe('MonitorBroker', () => {
  let registry = new MonitorRegistry(new ProcessRegistry());

  afterEach(async () => {
    registry.stopRun('run-1', 'teardown');
    await registry.settled('run-1', 5000);
  });

  function brokerOver(
    rows: Pick<Item, 'runId' | 'memberId' | 'seq' | 'payload'>[],
  ) {
    registry = new MonitorRegistry(new ProcessRegistry());
    const monitorRowsOfRuns = vi.fn(async () => rows);
    const broker = new MonitorBroker(
      registry,
      { monitorRowsOfRuns } as unknown as ItemDao,
      { fork: () => ({}) } as unknown as EntityManager,
    );
    broker.register('run-1', 'agent', {
      ownerOf: (caller) => ({
        owner: {
          runId: 'run-1',
          memberId: 'agent',
          caller,
          conversationId: null,
          callId: null,
          target: 'chat',
        },
        cwd: process.cwd(),
      }),
    });
    const start = (command: string) =>
      broker.start(
        'run-1',
        'agent',
        { command, description: 'nap', timeoutMs: 60_000 },
        'agent',
      );
    return { start, monitorRowsOfRuns };
  }

  it("reads a run's earlier monitor ids before its first monitor of the launch, so none is minted again", async () => {
    const { start, monitorRowsOfRuns } = brokerOver([
      startRow('m1'),
      startRow('m3'),
    ]);

    await expect(start('sleep 30')).resolves.toMatchObject({
      status: 'started',
      id: 'm4',
    });
    await expect(start('sleep 31')).resolves.toMatchObject({
      status: 'started',
      id: 'm5',
    });
    expect(monitorRowsOfRuns).toHaveBeenCalledTimes(1);
    expect(monitorRowsOfRuns).toHaveBeenCalledWith(['run-1'], {});
  });

  it('reads a run with no earlier monitors once, and starts it at m1', async () => {
    const { start, monitorRowsOfRuns } = brokerOver([]);

    await expect(start('sleep 30')).resolves.toMatchObject({ id: 'm1' });
    await expect(start('sleep 31')).resolves.toMatchObject({ id: 'm2' });
    expect(monitorRowsOfRuns).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for a run the boot sweep already handed its ids', async () => {
    const fresh = new MonitorRegistry(new ProcessRegistry());
    fresh.noteUsedIds('run-2', ['m2']);
    const monitorRowsOfRuns = vi.fn(async () => []);
    const broker = new MonitorBroker(
      fresh,
      { monitorRowsOfRuns } as unknown as ItemDao,
      { fork: () => ({}) } as unknown as EntityManager,
    );
    broker.register('run-2', 'agent', {
      ownerOf: (caller) => ({
        owner: {
          runId: 'run-2',
          memberId: 'agent',
          caller,
          conversationId: null,
          callId: null,
          target: 'chat',
        },
        cwd: process.cwd(),
      }),
    });
    try {
      await expect(
        broker.start(
          'run-2',
          'agent',
          { command: 'sleep 30', description: 'nap', timeoutMs: 60_000 },
          'agent',
        ),
      ).resolves.toMatchObject({ status: 'started', id: 'm3' });
      expect(monitorRowsOfRuns).not.toHaveBeenCalled();
    } finally {
      fresh.stopRun('run-2', 'teardown');
      await fresh.settled('run-2', 5000);
    }
  });
});
