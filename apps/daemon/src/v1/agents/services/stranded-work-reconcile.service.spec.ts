import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../dao/run.dao';
import type { ActionOutcomeSweep } from './action-outcome-sweep.service';
import type { ChatService } from './chat.service';
import type { MonitorOutcomeSweep } from './monitor-outcome-sweep.service';
import { StrandedWorkReconcileService } from './stranded-work-reconcile.service';

type Mark = {
  runId: string;
  newestSeq: number;
  reconciledThroughSeq: number | null;
};

function harness(
  before: Mark[],
  after: Mark[],
  unsettled: {
    delegates?: string[];
    shells?: string[];
    actions?: string[];
    monitors?: string[];
  } = {},
) {
  const em = {
    fork: () => em,
    transactional: async (work: (tx: unknown) => Promise<void>) => work(em),
  } as unknown as EntityManager;
  const reconcileMarks = vi
    .fn<() => Promise<Mark[]>>()
    .mockResolvedValueOnce(before)
    .mockResolvedValueOnce(after);
  const markReconciledThrough = vi.fn(
    async (_runId: string, _seq: number, _tx?: unknown) => undefined,
  );
  const reconcileStrandedDelegates = vi.fn(
    async (_: readonly string[]) => unsettled.delegates ?? [],
  );
  const reconcileStrandedShells = vi.fn(
    async (_: readonly string[]) => unsettled.shells ?? [],
  );
  const actionSweep = vi.fn(
    async (_: readonly string[]) => unsettled.actions ?? [],
  );
  const monitorSweep = vi.fn(
    async (_cause: string, _: readonly string[]) => unsettled.monitors ?? [],
  );
  const service = new StrandedWorkReconcileService(
    em,
    { reconcileMarks, markReconciledThrough } as unknown as RunDao,
    {
      reconcileStrandedDelegates,
      reconcileStrandedShells,
    } as unknown as ChatService,
    { sweep: actionSweep } as unknown as ActionOutcomeSweep,
    { sweep: monitorSweep } as unknown as MonitorOutcomeSweep,
  );
  return {
    service,
    markReconciledThrough,
    reconcileStrandedDelegates,
    reconcileStrandedShells,
    actionSweep,
    monitorSweep,
  };
}

describe('StrandedWorkReconcileService', () => {
  it('hands every reconcile only the runs written to since their mark, or never marked', async () => {
    const h = harness(
      [
        { runId: 'quiet', newestSeq: 9, reconciledThroughSeq: 9 },
        { runId: 'written', newestSeq: 12, reconciledThroughSeq: 9 },
        { runId: 'new', newestSeq: 3, reconciledThroughSeq: null },
        { runId: 'empty', newestSeq: -1, reconciledThroughSeq: -1 },
      ],
      [],
    );

    await h.service.reconcile('quit');

    const due = ['written', 'new'];
    expect(h.reconcileStrandedDelegates).toHaveBeenCalledWith(due);
    expect(h.reconcileStrandedShells).toHaveBeenCalledWith(due);
    expect(h.actionSweep).toHaveBeenCalledWith(due);
    expect(h.monitorSweep).toHaveBeenCalledWith('quit', due);
  });

  it('marks each run it read through its newest seq after the reconciles, except one any of them left open', async () => {
    const h = harness(
      [
        { runId: 'a', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'b', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'c', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'd', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'e', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 },
      ],
      [
        { runId: 'a', newestSeq: 6, reconciledThroughSeq: null },
        { runId: 'b', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'c', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'd', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'e', newestSeq: 5, reconciledThroughSeq: null },
        { runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 },
      ],
      {
        delegates: ['b'],
        shells: ['c'],
        actions: ['d'],
        monitors: [],
      },
    );

    await h.service.reconcile('quit');

    expect(h.markReconciledThrough.mock.calls.map(([id, seq]) => [id, seq])).toEqual([
      ['a', 6],
      ['e', 5],
    ]);
  });

  it('leaves a chat whose monitor end waits on a delivery unmarked', async () => {
    const h = harness(
      [{ runId: 'chat', newestSeq: 4, reconciledThroughSeq: 1 }],
      [{ runId: 'chat', newestSeq: 4, reconciledThroughSeq: 1 }],
      { monitors: ['chat'] },
    );

    await h.service.reconcile('quit');

    expect(h.markReconciledThrough).not.toHaveBeenCalled();
  });

  it('runs no reconcile when no run changed', async () => {
    const h = harness(
      [{ runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 }],
      [],
    );

    await h.service.reconcile('quit');

    expect(h.reconcileStrandedDelegates).not.toHaveBeenCalled();
    expect(h.monitorSweep).not.toHaveBeenCalled();
    expect(h.markReconciledThrough).not.toHaveBeenCalled();
  });
});
