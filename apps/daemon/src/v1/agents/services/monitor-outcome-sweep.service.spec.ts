import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterruptCause } from '../../../utils/stop-cause';
import type { Item } from '../../runs/entity/item.entity';
import type { MonitorRowPayload } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { monitorRowEntry, monitorRowPayload } from '../utils/monitor-text';
import { callSessionKey, nodeSessionKey } from '../utils/session-keys';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { MonitorRegistry } from './monitor.registry';
import type { MonitorChatDelivery } from './monitor-chat-delivery.service';
import { MonitorOutcomeSweep } from './monitor-outcome-sweep.service';
import type { MonitorRowWriter } from './monitor-row.writer';

const STARTED_AT = new Date('2026-11-22T10:00:00.000Z');
const FOUR_MINUTES_IN = new Date(STARTED_AT.getTime() + 4 * 60_000);

interface RowFixture {
  runId: string;
  memberId: string;
  seq: number;
  createdAt: Date;
  payload: string;
}

/** A row exactly as the writer and the deliveries persist it. */
const row = (
  seq: number,
  id: string,
  event: 'start' | 'end',
  callId: string | null = null,
  conversationId: string | null = null,
): RowFixture => ({
  runId: 'run-1',
  memberId: 'agent',
  seq,
  createdAt: STARTED_AT,
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

const monitorCall = (
  seq: number,
  input: { command: string; description?: string; timeout_ms?: number },
  memberId = 'agent',
): Pick<Item, 'memberId' | 'seq' | 'payload'> => ({
  memberId,
  seq,
  payload: JSON.stringify({
    name: 'mcp__geniro__monitor',
    input: { description: 'CI', ...input },
  }),
});

interface HarnessRun {
  teamId: string | null;
  archivedAt: Date | null;
  status?: string;
  restartContinuation?: string | null;
}

function harness(
  run: HarnessRun,
  rows: RowFixture[] = [
    row(1, 'm1', 'start'),
    row(2, 'm1', 'end'),
    row(3, 'm2', 'start'),
  ],
  toolCalls: Pick<Item, 'memberId' | 'seq' | 'payload'>[] = [],
) {
  const em = { fork: () => em } as unknown as EntityManager;
  const write = vi.fn(async () => true);
  const holdInterrupted = vi.fn();
  const oweRunNote = vi.fn();
  const oweKeyNote = vi.fn();
  const noteUsedIds = vi.fn();
  const setRestartContinuation = vi.fn();
  const sweep = new MonitorOutcomeSweep(
    em,
    {
      monitorRowsOfRuns: async (runIds: readonly string[]) =>
        rows.filter((r) => runIds.includes(r.runId)),
      monitorToolCallsOfRun: async () => toolCalls,
    } as unknown as ItemDao,
    {
      getById: async () => ({ id: 'run-1', ...run }),
      setRestartContinuation,
    } as unknown as RunDao,
    { write } as unknown as MonitorRowWriter,
    { holdInterrupted } as unknown as MonitorChatDelivery,
    { oweRunNote, oweKeyNote } as unknown as AgentSessionRegistry,
    { noteUsedIds } as unknown as MonitorRegistry,
  );
  return {
    sweep,
    write,
    holdInterrupted,
    oweRunNote,
    oweKeyNote,
    noteUsedIds,
    setRestartContinuation,
  };
}

function recordWritten(h: ReturnType<typeof harness>): unknown {
  return JSON.parse(h.setRestartContinuation.mock.calls[0]?.[1] as string);
}

describe('MonitorOutcomeSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FOUR_MINUTES_IN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the rows the writer persists with the pre-filter its DAO query uses', () => {
    // `ItemDao.monitorRowsOfRuns` filters `payload LIKE '%"monitors":[%'`.
    expect(row(1, 'm1', 'start').payload).toContain('"monitors":[');
  });

  it('hands a chat the wake for the monitors left without an end, and only those, after a quit', async () => {
    const h = harness({ teamId: null, archivedAt: null });
    // Its end is written only when that wake goes out, after listen.
    expect(await h.sweep.sweep('quit', ['run-1'])).toEqual(['run-1']);
    expect(h.holdInterrupted).toHaveBeenCalledTimes(1);
    expect(h.holdInterrupted).toHaveBeenCalledWith(
      { runId: 'run-1', memberId: 'agent', callId: null, conversationId: null },
      [expect.objectContaining({ id: 'm2', end: { kind: 'interrupted' } })],
    );
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each<InterruptCause>(['crash', 'unknown'])(
    'records the end but wakes nobody after a %s',
    async (cause) => {
      const h = harness({ teamId: null, archivedAt: null });
      expect(await h.sweep.sweep(cause, ['run-1'])).toEqual([]);
      expect(h.holdInterrupted).not.toHaveBeenCalled();
      expect(h.setRestartContinuation).not.toHaveBeenCalled();
      // Not woken, but told on the chat's next turn.
      expect(h.oweKeyNote).toHaveBeenCalledWith(
        'run-1',
        expect.stringContaining('m2 — CI — command not recorded'),
      );
      expect(h.write).toHaveBeenCalledWith(
        {
          runId: 'run-1',
          memberId: 'agent',
          callId: null,
          conversationId: null,
        },
        expect.objectContaining({
          id: 'm2',
          event: 'end',
          end: { kind: 'interrupted' },
        }),
        false,
      );
    },
  );

  it("owes a team member's own conversation a note instead of waking it", async () => {
    const h = harness({ teamId: 'wf', archivedAt: null });
    expect(await h.sweep.sweep('quit', ['run-1'])).toEqual([]);
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(h.setRestartContinuation).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      nodeSessionKey('run-1', 'agent'),
      expect.stringContaining('m2 — CI — command not recorded'),
    );
    expect(h.oweRunNote).not.toHaveBeenCalled();
  });

  it("files a callee's interrupted end under its call and owes that conversation the note", async () => {
    const h = harness({ teamId: 'wf', archivedAt: null }, [
      row(1, 'm1', 'start', 'call-3', 'call-1'),
    ]);
    await h.sweep.sweep('quit', ['run-1']);
    expect(h.write).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        memberId: 'agent',
        callId: 'call-3',
        conversationId: 'call-1',
      },
      expect.objectContaining({ id: 'm1', end: { kind: 'interrupted' } }),
      false,
    );
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      callSessionKey('run-1', 'call-1'),
      expect.stringContaining('m1 — CI — command not recorded'),
    );
    expect(h.oweRunNote).not.toHaveBeenCalled();
  });

  it("still owes the callee's conversation once a delivered batch, which names none, is its newest row", async () => {
    // A wake inside the call is filed as `wakeHeldCallee` files it: the
    // delivery's row plus the call, no conversation.
    const delivered: RowFixture = {
      runId: 'run-1',
      memberId: 'agent',
      seq: 2,
      createdAt: STARTED_AT,
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
    const h = harness({ teamId: 'wf', archivedAt: null }, [
      row(1, 'm1', 'start', 'call-3', 'call-1'),
      delivered,
    ]);
    await h.sweep.sweep('quit', ['run-1']);
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      callSessionKey('run-1', 'call-1'),
      expect.stringContaining('m1 — CI — command not recorded'),
    );
  });

  it('hands the registry every id the run already used, so none is minted again', async () => {
    const h = harness({ teamId: null, archivedAt: null });
    await h.sweep.sweep('quit', ['run-1']);
    expect(h.noteUsedIds).toHaveBeenCalledWith('run-1', expect.anything());
    expect([...(h.noteUsedIds.mock.calls[0]?.[1] as Iterable<string>)]).toEqual(
      ['m1', 'm2'],
    );
  });

  it('owes an archived run nothing', async () => {
    const h = harness({ teamId: null, archivedAt: new Date() });
    expect(await h.sweep.sweep('quit', ['run-1'])).toEqual([]);
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it('reads only the runs it is handed', async () => {
    const h = harness({ teamId: null, archivedAt: null });
    expect(await h.sweep.sweep('quit', ['other-run'])).toEqual([]);
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.noteUsedIds).not.toHaveBeenCalled();
  });

  it('answers a run whose interrupted end could not be written, so the next boot reads it again', async () => {
    const h = harness({ teamId: 'wf', archivedAt: null });
    h.write.mockResolvedValueOnce(false);
    expect(await h.sweep.sweep('quit', ['run-1'])).toEqual(['run-1']);
  });

  it('answers every run it was handed when it fails', async () => {
    const h = harness({ teamId: 'wf', archivedAt: null });
    h.write.mockRejectedValueOnce(new Error('disk I/O error'));
    expect(await h.sweep.sweep('quit', ['run-1', 'run-2'])).toEqual([
      'run-1',
      'run-2',
    ]);
  });
});

describe('MonitorOutcomeSweep after an update or a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FOUR_MINUTES_IN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['self-update', 'restart'] as const)(
    "keeps a team member's cut-off monitor in the run's record after a %s, marks its end as woken and owes no note",
    async (cause) => {
      const h = harness(
        { teamId: 'wf', archivedAt: null, status: 'running' },
        [row(3, 'm1', 'start')],
        [monitorCall(2, { command: 'npm run watch', timeout_ms: 1_200_000 })],
      );
      expect(await h.sweep.sweep(cause, ['run-1'])).toEqual([]);
      expect(recordWritten(h)).toEqual({
        cause,
        turns: [],
        calls: [],
        failedCalls: [],
        monitors: [
          {
            memberId: 'agent',
            conversationId: null,
            id: 'm1',
            description: 'CI',
            command: 'npm run watch',
            remainingMs: 960_000,
          },
        ],
      });
      expect(h.write).toHaveBeenCalledWith(
        {
          runId: 'run-1',
          memberId: 'agent',
          callId: null,
          conversationId: null,
        },
        expect.objectContaining({
          id: 'm1',
          event: 'end',
          end: { kind: 'interrupted' },
          command: 'npm run watch',
          startedAt: STARTED_AT.toISOString(),
        }),
        true,
      );
      expect(h.oweKeyNote).not.toHaveBeenCalled();
      expect(h.holdInterrupted).not.toHaveBeenCalled();
    },
  );

  it('writes a monitors-only record for a team run whose turn already ended', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'completed' },
      [row(3, 'm1', 'start')],
      [monitorCall(2, { command: 'npm run watch' })],
    );
    await h.sweep.sweep('self-update', ['run-1']);
    expect(recordWritten(h)).toEqual({
      cause: 'self-update',
      turns: [],
      calls: [],
      failedCalls: [],
      monitors: [
        expect.objectContaining({
          id: 'm1',
          command: 'npm run watch',
          remainingMs: 360_000,
        }),
      ],
    });
  });

  it("gives a team member's conversation a note naming the command after a quit, with no record", async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'running' },
      [row(3, 'm1', 'start')],
      [monitorCall(2, { command: 'npm run watch' })],
    );
    expect(await h.sweep.sweep('quit', ['run-1'])).toEqual([]);
    expect(h.setRestartContinuation).not.toHaveBeenCalled();
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      nodeSessionKey('run-1', 'agent'),
      expect.stringContaining('m1 — CI — `npm run watch` (~6 min were left)'),
    );
    expect(h.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'm1' }),
      false,
    );
  });

  it("merges a chat's cut-off monitor into the record it is owed, keeping its turn and holding no turn", async () => {
    const owed = JSON.stringify({
      cause: 'self-update',
      turns: [{ memberId: 'agent' }],
      calls: [],
      failedCalls: [],
      monitors: [],
    });
    const h = harness(
      { teamId: null, archivedAt: null, restartContinuation: owed },
      undefined,
      [monitorCall(2, { command: 'npm run watch' })],
    );
    expect(await h.sweep.sweep('restart', ['run-1'])).toEqual([]);
    expect(h.holdInterrupted).not.toHaveBeenCalled();
    expect(recordWritten(h)).toEqual({
      cause: 'restart',
      turns: [{ memberId: 'agent' }],
      calls: [],
      failedCalls: [],
      monitors: [
        {
          memberId: null,
          conversationId: null,
          id: 'm2',
          description: 'CI',
          command: 'npm run watch',
          remainingMs: 360_000,
        },
      ],
    });
    expect(h.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'm2' }),
      true,
    );
  });

  it('holds a chat with no record for its next turn, naming the command its monitor had', async () => {
    const h = harness({ teamId: null, archivedAt: null }, undefined, [
      monitorCall(2, { command: 'npm run watch' }),
    ]);
    expect(await h.sweep.sweep('restart', ['run-1'])).toEqual(['run-1']);
    expect(h.holdInterrupted).toHaveBeenCalledWith(
      { runId: 'run-1', memberId: 'agent', callId: null, conversationId: null },
      [
        expect.objectContaining({
          id: 'm2',
          end: { kind: 'interrupted' },
          stopped: {
            id: 'm2',
            description: 'CI',
            command: 'npm run watch',
            remainingMs: 360_000,
          },
        }),
      ],
    );
    expect(h.setRestartContinuation).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
  });

  it('records a monitor whose call is not found with no command and no time left', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'running' },
      [row(3, 'm1', 'start')],
      [],
    );
    await h.sweep.sweep('self-update', ['run-1']);
    expect(recordWritten(h)).toEqual({
      cause: 'self-update',
      turns: [],
      calls: [],
      failedCalls: [],
      monitors: [
        {
          memberId: 'agent',
          conversationId: null,
          id: 'm1',
          description: 'CI',
          command: null,
          remainingMs: null,
        },
      ],
    });
    const [, entry] = h.write.mock.calls[0] as unknown as [
      unknown,
      MonitorRowPayload,
    ];
    expect(entry).not.toHaveProperty('command');
    expect(entry.startedAt).toBe(STARTED_AT.toISOString());
  });

  it('writes the interrupted end with the command, start and timeout its own start row carries', async () => {
    const started = {
      ...row(3, 'm1', 'start'),
      payload: JSON.stringify(
        monitorRowPayload(
          [
            monitorRowEntry(
              {
                id: 'm1',
                description: 'CI',
                command: 'gh run watch 7',
                startedAt: '2026-11-20T08:00:00.000Z',
                timeoutMs: 900_000,
                batch: { lines: [], omitted: 0 },
              },
              'start',
            ),
          ],
          null,
          false,
        ),
      ),
    };
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'running' },
      [started],
      [monitorCall(2, { command: 'an older call' })],
    );
    await h.sweep.sweep('self-update', ['run-1']);
    expect(h.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'm1',
        end: { kind: 'interrupted' },
        command: 'gh run watch 7',
        startedAt: '2026-11-20T08:00:00.000Z',
        timeoutMs: 900_000,
      }),
      true,
    );
  });

  it('takes the command only from a call of the same description made before its start', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'running' },
      [row(3, 'm1', 'start')],
      [
        monitorCall(4, { command: 'made after the start' }),
        monitorCall(2, { command: 'another monitor', description: 'Build' }),
      ],
    );
    await h.sweep.sweep('self-update', ['run-1']);
    expect(recordWritten(h)).toEqual({
      cause: 'self-update',
      turns: [],
      calls: [],
      failedCalls: [],
      monitors: [
        expect.objectContaining({ id: 'm1', command: null, remainingMs: null }),
      ],
    });
  });

  it('counts a monitor whose call named no timeout from the default one', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'running' },
      [row(3, 'm1', 'start')],
      [monitorCall(2, { command: 'npm run watch' })],
    );
    await h.sweep.sweep('self-update', ['run-1']);
    expect(recordWritten(h)).toEqual({
      cause: 'self-update',
      turns: [],
      calls: [],
      failedCalls: [],
      monitors: [expect.objectContaining({ id: 'm1', remainingMs: 360_000 })],
    });
  });

  it('owes an archived team run no record and no note after an update', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: new Date() },
      [row(3, 'm1', 'start')],
      [monitorCall(2, { command: 'npm run watch' })],
    );
    expect(await h.sweep.sweep('self-update', ['run-1'])).toEqual([]);
    expect(h.setRestartContinuation).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'm1' }),
      false,
    );
  });

  it('owes a cancelled team run no record and no note after a restart', async () => {
    const h = harness(
      { teamId: 'wf', archivedAt: null, status: 'cancelled' },
      [row(3, 'm1', 'start')],
      [monitorCall(2, { command: 'npm run watch' })],
    );
    expect(await h.sweep.sweep('restart', ['run-1'])).toEqual([]);
    expect(h.setRestartContinuation).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
  });
});
