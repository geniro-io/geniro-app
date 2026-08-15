import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type { AgentContextUsage } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentSessionRegistry } from './agent-session.registry';
import { ChatMetricsService } from './chat-metrics.service';

const BREAKDOWN: AgentContextUsage = {
  categories: [{ name: 'System prompt', tokens: 3386, deferred: false }],
  totalTokens: 3386,
  maxTokens: 1_000_000,
  model: 'claude-opus-5[1m]',
  autoCompactAtTokens: 967_000,
  autoCompactEnabled: true,
  memoryFiles: [],
  servers: [],
};

/** One stored `turn_complete` payload, as the transcript holds it. */
function turn(usage: Record<string, unknown> | null): string {
  return JSON.stringify({ usage, stopReason: 'end_turn' });
}

function build(opts: {
  agentKind?: AgentKind | null;
  runExists?: boolean;
  payloads?: string[];
  breakdown?: AgentContextUsage | null;
  breakdownUnavailableReason?: string | null;
  readContextUsage?: () => Promise<AgentContextUsage | null>;
}) {
  const readContextUsage =
    opts.readContextUsage ??
    vi.fn().mockResolvedValue('breakdown' in opts ? opts.breakdown : BREAKDOWN);
  const service = new ChatMetricsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      getById: () =>
        Promise.resolve(
          opts.runExists === false
            ? null
            : {
                agentKind:
                  'agentKind' in opts ? opts.agentKind : AgentKind.Claude,
              },
        ),
    } as unknown as RunDao,
    {
      turnCompletePayloads: () => Promise.resolve(opts.payloads ?? []),
    } as unknown as ItemDao,
    { readContextUsage } as unknown as AgentSessionRegistry,
    {
      for: () =>
        ({
          getConfig: () => ({
            usage: {
              unavailableReason: null,
              breakdownUnavailableReason:
                opts.breakdownUnavailableReason ?? null,
            },
          }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry,
  );
  return { service, readContextUsage };
}

describe('ChatMetricsService', () => {
  it('answers with the live breakdown and no reason when one was taken', () => {
    const { service } = build({});

    return expect(service.read('run-1')).resolves.toMatchObject({
      context: BREAKDOWN,
      breakdownReason: null,
    });
  });

  it('names the CLI’s OWN reason when it has no such channel', async () => {
    // The whole point of the field: an agent that will never answer must read
    // differently from one whose process has simply been reaped.
    const { service, readContextUsage } = build({
      agentKind: AgentKind.CursorAgent,
      breakdownUnavailableReason: 'cursor-agent has no channel for one',
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toBe('cursor-agent has no channel for one');
    // Not even asked — the adapter has already said there is nothing to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it('tells the user how to get one back when the chat holds no process', async () => {
    const { service } = build({ breakdown: null });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
  });

  it('answers the totals even when the breakdown could not be taken', async () => {
    // The two halves are independent: the spend is persisted history and is
    // always there, and losing it with the live reading would be the readout
    // going blank on every idle chat.
    const { service } = build({
      breakdown: null,
      payloads: [turn({ costUsd: 0.25, inputTokens: 10 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals).toMatchObject({ turns: 1, costUsd: 0.25 });
  });

  it('survives a live reading that threw, rather than failing the request', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      payloads: [turn({ costUsd: 1 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals.costUsd).toBe(1);
  });

  it('sums every figure across the thread’s turns', async () => {
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.2,
          inputTokens: 2,
          outputTokens: 16,
          cacheReadTokens: 100,
          cacheCreationTokens: 20,
          thinkingTokens: 4,
          durationMs: 2531,
        }),
        turn({
          costUsd: 0.3,
          inputTokens: 3,
          outputTokens: 24,
          cacheReadTokens: 900,
          cacheCreationTokens: 80,
          thinkingTokens: 6,
          durationMs: 1000,
        }),
      ],
    });

    expect((await service.read('run-1')).totals).toEqual({
      turns: 2,
      costUsd: 0.5,
      inputTokens: 5,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheCreationTokens: 100,
      thinkingTokens: 10,
      workedMs: 3531,
    });
  });

  it('leaves a figure NO turn reported null rather than zero', async () => {
    // A chat on a CLI that reports no usage must read as "not measured", never
    // as "cost nothing" — the two are indistinguishable once seeded at 0.
    const { service } = build({
      payloads: [turn({ inputTokens: 5 })],
    });

    const { totals } = await service.read('run-1');

    expect(totals.inputTokens).toBe(5);
    expect(totals.costUsd).toBeNull();
    expect(totals.thinkingTokens).toBeNull();
    expect(totals.workedMs).toBeNull();
  });

  it('counts only the turns that actually reported usage', async () => {
    const { service } = build({
      payloads: [turn({ costUsd: 1 }), turn(null), 'not json at all'],
    });

    expect((await service.read('run-1')).totals).toMatchObject({
      turns: 1,
      costUsd: 1,
    });
  });

  it('refuses a run that does not exist', () => {
    const { service } = build({ runExists: false });

    return expect(service.read('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('says a run naming no single agent has no one window to report', async () => {
    const { service, readContextUsage } = build({ agentKind: null });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('no single agent');
    expect(readContextUsage).not.toHaveBeenCalled();
  });
});
