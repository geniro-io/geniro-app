import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemWire } from '../../agents/chat.types';
import type { NodeStateDao } from '../../agents/dao/node-state.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { UsageEventDao } from '../dao/usage-event.dao';
import {
  POLLED_SPEND_SEQ,
  type UsageEventInput,
  type UsageRecordedEvent,
} from '../stats.types';
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
  let recordPolledSpend: ReturnType<typeof vi.fn>;
  let polled: UsageEventInput[];
  let run: {
    id?: string;
    agentKind: string | null;
    model: string | null;
    cwd: string | null;
    workflowId?: string | null;
    workflowSnapshot?: string | null;
    polledCostCents?: number | null;
    updatedAt?: Date;
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
          ttftMs: 210,
          timeToRequestMs: 40,
          numTurns: 3,
        },
        stopReason: 'end_turn',
      },
      createdAt: '2026-08-14T09:30:00.000Z',
      ...overrides,
    };
  }

  function start(
    shares: {
      nodeId: string;
      agentKind: string;
      polledCostCents: number;
    }[] = [],
    adapters?: AgentAdapterRegistry,
  ): void {
    const service = new UsageRecorderService(
      em,
      bus,
      { getById: async () => run } as unknown as RunDao,
      {
        getByRunNode: async () => nodeState,
        polledSharesForRuns: async () => shares,
      } as unknown as NodeStateDao,
      {
        recordOnce,
        recordPolledSpend,
        latestReportedModel: async () => null,
      } as unknown as UsageEventDao,
      usageBus,
      adapters,
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
    polled = [];
    recordPolledSpend = vi.fn(
      async (_runId: string, rows: readonly UsageEventInput[]) => {
        polled.push(...rows);
        return true;
      },
    );
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
      // Real pin: these three reach the ledger row only because
      // `MeasuredUsageKey`'s `Extract` names them — dropping them there
      // would silently null every one of these three fields here.
      ttftMs: 210,
      timeToRequestMs: 40,
      numTurns: 3,
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

  it('records what a FAILED turn spent, carried on its error row', async () => {
    start();

    bus.publish({
      runId: 'run-a',
      item: usageItem({
        kind: 'error',
        payload: {
          message: "You've hit your session limit",
          usage: { costUsd: 56.69, outputTokens: 193_000 },
        },
      }),
    });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({
      costUsd: 56.69,
      outputTokens: 193_000,
    });
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

  it('files a turn another pool member ran under that member, not the node’s stamp', async () => {
    // A pooled node is stamped with member 1; the call ran on member 2, and a
    // failed one names it on its error row too.
    run = { agentKind: null, model: null, cwd: '/work/project' };
    nodeState = { agentKind: 'claude', model: 'opus' };
    start();

    bus.publish({
      runId: 'run-a',
      item: usageItem({
        nodeId: 'node-7',
        kind: 'error',
        payload: {
          message: 'boom',
          usage: { costUsd: 1 },
          agentKind: 'codex',
          agentModel: 'gpt-5.5',
        },
      }),
    });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({ agentKind: 'codex', model: 'gpt-5.5' });
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
  describe('polled spend', () => {
    /** A cursor run the account poll has priced, as its run row reads. */
    function pricedRun(): NonNullable<typeof run> {
      return {
        id: 'run-cursor',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        cwd: '/work/project',
        workflowId: null,
        workflowSnapshot: null,
        polledCostCents: 250,
        updatedAt: new Date('2026-08-14T09:30:00.000Z'),
      };
    }

    /** The announce `PolledSpendService` makes once a run's total moved. */
    function announceSpend(runId = 'run-cursor'): void {
      bus.publishRunStatus({ runId, status: null, spendUpdatedAt: 1 });
    }

    it('files a POOLED node’s bill under the member that polls, not under its member-1 stamp', async () => {
      // The node is claude (member 1) with a cursor member: its polled bill is
      // cursor's, though node_state names claude.
      run = {
        ...pricedRun(),
        id: 'run-team',
        agentKind: null,
        model: null,
        workflowId: 'team',
        workflowSnapshot: JSON.stringify({
          nodes: [
            {
              id: 'qa',
              kind: 'agent',
              agent: 'claude',
              pool: [{ agent: 'cursor-agent' }],
            },
          ],
        }),
      };
      const polls = (kind: string): boolean => kind === 'cursor-agent';
      start([{ nodeId: 'qa', agentKind: 'claude', polledCostCents: 250 }], {
        all: () =>
          new Map(
            ['claude', 'cursor-agent'].map((kind) => [
              kind,
              { getConfig: () => ({ usage: { polledSpend: polls(kind) } }) },
            ]),
          ),
      } as unknown as AgentAdapterRegistry);

      announceSpend('run-team');

      await vi.waitFor(() => expect(polled).toHaveLength(1));
      expect(polled[0]).toMatchObject({ agentKind: 'cursor-agent' });
    });

    it('restates the run’s polled total in the ledger when the poll says it moved', async () => {
      // The poll writes `Run.polledCostCents`, which the teardown destroys.
      // Without this copy a deleted cursor chat took its whole bill out of
      // Stats — the one loss the ledger exists to prevent.
      run = pricedRun();
      start();

      announceSpend();

      await vi.waitFor(() => expect(polled).toHaveLength(1));
      expect(polled[0]).toMatchObject({
        runId: 'run-cursor',
        seq: POLLED_SPEND_SEQ,
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        cwd: '/work/project',
        costUsd: 2.5,
      });
      // …and tells an open Stats page to re-read, dated as the row is.
      await vi.waitFor(() =>
        expect(announced).toEqual([
          {
            runId: 'run-cursor',
            nodeId: null,
            occurredAt: '2026-08-14T09:30:00.000Z',
          },
        ]),
      );
    });

    it('ignores a status announce that says nothing about spend', async () => {
      run = pricedRun();
      start();

      bus.publishRunStatus({ runId: 'run-cursor', status: 'completed' });

      await new Promise((resolve) => setImmediate(resolve));
      expect(recordPolledSpend).not.toHaveBeenCalled();
    });

    it('announces nothing when the ledger already held that total', async () => {
      run = pricedRun();
      recordPolledSpend.mockResolvedValueOnce(false);
      start();

      announceSpend();

      await vi.waitFor(() => expect(recordPolledSpend).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));
      expect(announced).toEqual([]);
    });

    it('leaves the ledger’s last total alone once the run is gone', async () => {
      // The teardown can land between the poll's write and this read. The row
      // already holds the total before it, which is what must survive — never a
      // row rewritten from a run that no longer says anything.
      run = null;
      start();

      announceSpend();

      await new Promise((resolve) => setImmediate(resolve));
      expect(recordPolledSpend).not.toHaveBeenCalled();
    });

    it('survives a failing write — the accounting is lost, the poll is not', async () => {
      run = pricedRun();
      recordPolledSpend = vi.fn(async () => {
        throw new Error('disk full');
      });
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      start();

      announceSpend();

      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(String(warn.mock.calls[0]![0])).toContain('disk full');
      announceSpend();
      await vi.waitFor(() =>
        expect(recordPolledSpend).toHaveBeenCalledTimes(2),
      );
      warn.mockRestore();
    });
  });
});
