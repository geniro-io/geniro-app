import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { InterruptCause } from '../../../utils/stop-cause';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { monitorRowEntry, monitorRowPayload } from '../utils/monitor-text';
import { callSessionKey, nodeSessionKey } from '../utils/session-keys';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { MonitorRegistry } from './monitor.registry';
import type { MonitorChatDelivery } from './monitor-chat-delivery.service';
import { MonitorOutcomeSweep } from './monitor-outcome-sweep.service';
import type { MonitorRowWriter } from './monitor-row.writer';

/** A row exactly as the writer and the deliveries persist it. */
const row = (
  seq: number,
  id: string,
  event: 'start' | 'end',
  callId: string | null = null,
  conversationId: string | null = null,
) => ({
  runId: 'run-1',
  nodeId: 'agent',
  seq,
  payload: JSON.stringify(
    monitorRowPayload(
      [
        monitorRowEntry(
          {
            id,
            description: 'CI',
            batch: { lines: [], omitted: 0 },
            ...(event === 'end'
              ? { end: { kind: 'exit' as const, code: 0 } }
              : {}),
          },
          event,
        ),
      ],
      callId,
      false,
      conversationId,
    ),
  ),
});

function harness(
  run: { workflowId: string | null; archivedAt: Date | null },
  rows = [row(1, 'm1', 'start'), row(2, 'm1', 'end'), row(3, 'm2', 'start')],
) {
  const em = { fork: () => em } as unknown as EntityManager;
  const write = vi.fn(async () => undefined);
  const holdInterrupted = vi.fn();
  const oweRunNote = vi.fn();
  const oweKeyNote = vi.fn();
  const noteUsedIds = vi.fn();
  const sweep = new MonitorOutcomeSweep(
    em,
    { allMonitorRows: async () => rows } as unknown as ItemDao,
    { getById: async () => ({ id: 'run-1', ...run }) } as unknown as RunDao,
    { write } as unknown as MonitorRowWriter,
    { holdInterrupted } as unknown as MonitorChatDelivery,
    { oweRunNote, oweKeyNote } as unknown as AgentSessionRegistry,
    { noteUsedIds } as unknown as MonitorRegistry,
  );
  return { sweep, write, holdInterrupted, oweRunNote, oweKeyNote, noteUsedIds };
}

describe('MonitorOutcomeSweep', () => {
  it('matches the rows the writer persists with the pre-filter its DAO query uses', () => {
    // `ItemDao.allMonitorRows` filters `payload LIKE '%"monitors":[%'`.
    expect(row(1, 'm1', 'start').payload).toContain('"monitors":[');
  });

  it('hands a chat the wake for the monitors left without an end, and only those, after a quit', async () => {
    const h = harness({ workflowId: null, archivedAt: null });
    await h.sweep.sweep('quit');
    expect(h.holdInterrupted).toHaveBeenCalledTimes(1);
    expect(h.holdInterrupted).toHaveBeenCalledWith(
      { runId: 'run-1', nodeId: 'agent', callId: null, conversationId: null },
      [expect.objectContaining({ id: 'm2', end: { kind: 'interrupted' } })],
    );
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each<InterruptCause>(['crash', 'unknown'])(
    'records the end but wakes nobody after a %s',
    async (cause) => {
      const h = harness({ workflowId: null, archivedAt: null });
      await h.sweep.sweep(cause);
      expect(h.holdInterrupted).not.toHaveBeenCalled();
      // Not woken, but told on the chat's next turn.
      expect(h.oweKeyNote).toHaveBeenCalledWith(
        'run-1',
        expect.stringContaining('m2 (CI)'),
      );
      expect(h.write).toHaveBeenCalledWith(
        { runId: 'run-1', nodeId: 'agent', callId: null, conversationId: null },
        expect.objectContaining({
          id: 'm2',
          event: 'end',
          end: { kind: 'interrupted' },
        }),
      );
    },
  );

  it("owes a workflow node's own conversation a note instead of waking it", async () => {
    const h = harness({ workflowId: 'wf', archivedAt: null });
    await h.sweep.sweep('quit');
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      nodeSessionKey('run-1', 'agent'),
      expect.stringContaining('m2 (CI)'),
    );
    expect(h.oweRunNote).not.toHaveBeenCalled();
  });

  it("files a callee's interrupted end under its call and owes that conversation the note", async () => {
    const h = harness({ workflowId: 'wf', archivedAt: null }, [
      row(1, 'm1', 'start', 'call-3', 'call-1'),
    ]);
    await h.sweep.sweep('quit');
    expect(h.write).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        nodeId: 'agent',
        callId: 'call-3',
        conversationId: 'call-1',
      },
      expect.objectContaining({ id: 'm1', end: { kind: 'interrupted' } }),
    );
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      callSessionKey('run-1', 'call-1'),
      expect.stringContaining('m1 (CI)'),
    );
    expect(h.oweRunNote).not.toHaveBeenCalled();
  });

  it("still owes the callee's conversation once a delivered batch, which names none, is its newest row", async () => {
    // A wake inside the call is filed as `wakeHeldCallee` files it: the
    // delivery's row plus the call, no conversation.
    const delivered = {
      runId: 'run-1',
      nodeId: 'agent',
      seq: 2,
      payload: JSON.stringify({
        ...monitorRowPayload(
          [
            monitorRowEntry(
              {
                id: 'm1',
                description: 'CI',
                batch: { lines: ['1'], omitted: 0 },
              },
              'batch',
            ),
          ],
          null,
          true,
        ),
        callId: 'call-3',
      }),
    };
    const h = harness({ workflowId: 'wf', archivedAt: null }, [
      row(1, 'm1', 'start', 'call-3', 'call-1'),
      delivered,
    ]);
    await h.sweep.sweep('quit');
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      callSessionKey('run-1', 'call-1'),
      expect.stringContaining('m1 (CI)'),
    );
  });

  it('hands the registry every id the run already used, so none is minted again', async () => {
    const h = harness({ workflowId: null, archivedAt: null });
    await h.sweep.sweep('quit');
    expect(h.noteUsedIds).toHaveBeenCalledWith('run-1', expect.anything());
    expect([...(h.noteUsedIds.mock.calls[0]?.[1] as Iterable<string>)]).toEqual(
      ['m1', 'm2'],
    );
  });

  it('owes an archived run nothing', async () => {
    const h = harness({ workflowId: null, archivedAt: new Date() });
    await h.sweep.sweep('quit');
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});
