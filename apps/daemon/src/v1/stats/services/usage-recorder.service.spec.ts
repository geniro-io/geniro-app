import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemWire } from '../../agents/chat.types';
import type { NodeStateDao } from '../../agents/dao/node-state.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEventInput, UsageRecordedEvent } from '../stats.types';
import { UsageEventBus } from './usage-events.bus';
import { UsageRecorderService } from './usage-recorder.service';

/**
 * The recorder is driven through the REAL `AgentEventBus`, not a stub of it:
 * what this service promises is that publishing a persisted item is enough to
 * get it into the ledger, and a stubbed bus would let that promise hold while
 * the subscription was wired to something no execution path publishes on.
 */
describe('UsageRecorderService', () => {
  let bus: AgentEventBus;
  let usageBus: UsageEventBus;
  /** What the ledger bus announced — the live Stats page's only cue. */
  let announced: UsageRecordedEvent[];
  let recorded: UsageEventInput[];
  let recordOnce: ReturnType<typeof vi.fn>;
  let run: {
    agentKind: string | null;
    model: string | null;
    cwd: string | null;
  } | null;
  let nodeState: { agentKind: string | null; model: string | null } | null;

  const em = { fork: () => em } as unknown as EntityManager;

  function usageItem(overrides: Partial<ItemWire> = {}): ItemWire {
    return {
      id: 'item-1',
      runId: 'run-a',
      nodeId: null,
      seq: 4,
      kind: 'turn_complete',
      role: null,
      payload: {
        usage: {
          costUsd: 0.5,
          inputTokens: 1_200,
          outputTokens: 340,
          cacheReadTokens: 90,
          cacheCreationTokens: 12,
          thinkingTokens: 7,
          durationMs: 8_000,
          apiMs: 6_500,
        },
        stopReason: 'end_turn',
      },
      createdAt: '2026-08-14T09:30:00.000Z',
      ...overrides,
    };
  }

  function start(): void {
    const service = new UsageRecorderService(
      em,
      bus,
      { getById: async () => run } as unknown as RunDao,
      { getByRunNode: async () => nodeState } as unknown as NodeStateDao,
      { recordOnce } as unknown as UsageEventDao,
      usageBus,
    );
    service.onModuleInit();
  }

  beforeEach(() => {
    bus = new AgentEventBus();
    usageBus = new UsageEventBus();
    announced = [];
    usageBus.all().subscribe((event) => announced.push(event));
    recorded = [];
    recordOnce = vi.fn(async (row: UsageEventInput) => {
      recorded.push(row);
      return true;
    });
    run = { agentKind: 'claude', model: 'claude-opus-5', cwd: '/work/project' };
    nodeState = null;
  });

  it('records a finished turn published on the bus', async () => {
    start();

    bus.publish({ runId: 'run-a', item: usageItem() });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({
      runId: 'run-a',
      nodeId: null,
      seq: 4,
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      costUsd: 0.5,
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 90,
      cacheCreationTokens: 12,
      thinkingTokens: 7,
      durationMs: 8_000,
      apiMs: 6_500,
    });
  });

  it('announces a NEWLY recorded turn, and says nothing for one already held', async () => {
    start();

    bus.publish({ runId: 'run-a', item: usageItem() });

    await vi.waitFor(() => expect(announced).toHaveLength(1));
    expect(announced[0]).toEqual({
      runId: 'run-a',
      nodeId: null,
      occurredAt: '2026-08-14T09:30:00.000Z',
    });

    // A turn the ledger already holds moves no total, so an open Stats page
    // must not be told to re-read for it.
    recordOnce.mockResolvedValueOnce(false);
    bus.publish({ runId: 'run-a', item: usageItem({ seq: 5 }) });

    await vi.waitFor(() => expect(recordOnce).toHaveBeenCalledTimes(2));
    expect(announced).toHaveLength(1);
  });

  it('stamps the turn with the ITEM’s timestamp, not the moment it was recorded', async () => {
    start();

    bus.publish({ runId: 'run-a', item: usageItem() });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    // The backfill writes rows long after the fact; a `new Date()` here would
    // bucket a year of recovered history into the day the ledger was added.
    expect(recorded[0]!.occurredAt.toISOString()).toBe(
      '2026-08-14T09:30:00.000Z',
    );
  });

  it('ignores every item kind that is not a finished turn', async () => {
    start();

    bus.publish({
      runId: 'run-a',
      item: usageItem({ kind: 'message', payload: { text: 'hello' } }),
    });
    bus.publish({
      runId: 'run-a',
      item: usageItem({ kind: 'tool_call', payload: { name: 'ls' } }),
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(recordOnce).not.toHaveBeenCalled();
  });

  it('writes nothing for a turn that reported no usage', async () => {
    start();

    // A turn that ended without a usage block — a zero-filled row here would be
    // indistinguishable from a turn that genuinely cost nothing.
    bus.publish({
      runId: 'run-a',
      item: usageItem({ payload: { stopReason: 'end_turn' } }),
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(recordOnce).not.toHaveBeenCalled();
  });

  it('attributes a graph node’s turn to the node’s own agent and model', async () => {
    // A workflow run names no single agent — reading the run alone would
    // attribute every node's spend to nothing.
    run = { agentKind: null, model: null, cwd: '/work/project' };
    nodeState = { agentKind: 'cursor-agent', model: 'composer-1' };
    start();

    bus.publish({
      runId: 'run-a',
      item: usageItem({ nodeId: 'node-7' }),
    });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({
      nodeId: 'node-7',
      agentKind: 'cursor-agent',
      model: 'composer-1',
      // `node_state` stamps no cwd, so it still comes from the run.
      cwd: '/work/project',
    });
  });

  it('records a turn whose run row has already gone, rather than dropping it', async () => {
    // The teardown deletes the run before a straggling write settles. The row
    // is what outlives the run, so an absent run must cost the DIMENSIONS and
    // never the figures.
    run = null;
    start();

    bus.publish({ runId: 'run-a', item: usageItem() });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({
      agentKind: null,
      model: null,
      cwd: null,
      costUsd: 0.5,
    });
  });

  it('survives a failing write — the accounting is lost, the turn plumbing is not', async () => {
    // A rejection escaping an RxJS subscriber becomes an unhandled rejection
    // and reaches the process-level crash guard. Without the catch this test
    // records the failure as an unhandled rejection instead of a warning.
    recordOnce = vi.fn(async () => {
      throw new Error('disk full');
    });
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    start();

    bus.publish({ runId: 'run-a', item: usageItem() });

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0]![0])).toContain('disk full');
    // A second publish still lands, so the failure did not tear the
    // subscription down with it.
    bus.publish({ runId: 'run-a', item: usageItem({ seq: 5 }) });
    await vi.waitFor(() => expect(recordOnce).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});
