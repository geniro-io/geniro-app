import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type { AgentContextUsage } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ChatMetricsWireSchema } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentSessionRegistry } from './agent-session.registry';
import { ChatMetricsService } from './chat-metrics.service';

/**
 * Every NAMED component of the wire shape populated, not just the top level.
 *
 * `memoryFiles` and `servers` were empty here, and the wire round-trip below
 * reads whatever this fixture produces — so `ContextMemoryFile` and
 * `ContextServer` were never entered, and dropping a field from either passed
 * the whole suite AND the type gate while losing that field on the way to the
 * renderer. A fixture that skips an arm cannot pin the arm.
 */
const BREAKDOWN: AgentContextUsage = {
  categories: [
    { name: 'System prompt', tokens: 3386, deferred: false },
    { name: 'MCP tools', tokens: 273_876, deferred: true },
  ],
  totalTokens: 3386,
  maxTokens: 1_000_000,
  model: 'claude-opus-5[1m]',
  autoCompactAtTokens: 967_000,
  autoCompactEnabled: true,
  memoryFiles: [{ path: '/proj/CLAUDE.md', kind: 'Project', tokens: 45_947 }],
  servers: [
    { name: 'amplitude', tokens: 109_284, toolCount: 33, loadedToolCount: 0 },
  ],
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
  /**
   * What the run holds to be asked THROUGH. Defaults to a recorded session id,
   * which is the shape every existing case was written against; `null` on both
   * is the chat with nothing to ask at all.
   */
  agentSessionId?: string | null;
  liveSession?: unknown;
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
    {
      getByRunNode: () =>
        Promise.resolve({
          agentSessionId:
            'agentSessionId' in opts ? opts.agentSessionId : 'sess-1',
        }),
    } as unknown as NodeStateDao,
    { peek: () => opts.liveSession ?? null } as unknown as AgentSessionRegistry,
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
          readContextUsage,
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

  it('answers something the wire schema accepts UNCHANGED', async () => {
    // The route serializes this reply THROUGH `ChatMetricsWireSchema`
    // (`@ZodResponse` → `ChatMetricsDto`), and zod strips what the schema does
    // not name — silently, so a field the service produces and the schema
    // omits vanishes between here and the renderer with nothing failing. The
    // strict parse is what makes that a test failure instead; comparing the
    // parsed value back against the original is what catches a DROPPED field,
    // which a bare `.parse()` would let through.
    //
    // Driven with every named component populated AND with real totals: the
    // check can only reach the arms the fixture reaches, so an empty
    // `memoryFiles` left `ContextMemoryFile` unverified, and all-null totals
    // left every `ChatTotals` field's non-null arm unverified.
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.42,
          inputTokens: 24,
          outputTokens: 1_200,
          cacheReadTokens: 1_300_000,
          cacheCreationTokens: 210_000,
          thinkingTokens: 300,
          durationMs: 252_000,
        }),
      ],
    });

    const metrics = await service.read('run-1');

    // The fixture actually reached the nested arms — otherwise this test
    // certifies the top level alone while reading as though it covered all of
    // it, which is what it did before.
    expect(metrics.context?.memoryFiles).toHaveLength(1);
    expect(metrics.context?.servers).toHaveLength(1);
    expect(metrics.totals.costUsd).not.toBeNull();
    expect(ChatMetricsWireSchema.parse(metrics)).toEqual(metrics);
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
    // NOTHING to ask through: no live process and no recorded session id.
    const { service, readContextUsage } = build({
      breakdown: null,
      agentSessionId: null,
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
    // And it was not asked, because there was nobody to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it('does NOT tell the user to send a message when the agent was there and stayed silent', async () => {
    // The reported shape: an agent mid-turn whose context request did not come
    // back. "Send a message to take a fresh reading" is the cure for the case
    // above and a red herring here — the channel exists, so looking again is
    // what produces a reading, and a message costs the user a turn for nothing.
    const { service, readContextUsage } = build({
      breakdown: null,
      liveSession: { ask: () => Promise.resolve(null) },
    });

    const metrics = await service.read('run-1');

    expect(readContextUsage).toHaveBeenCalled();
    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).not.toContain('send a message');
    expect(metrics.breakdownReason).toContain('did not answer');
  });

  it('reads a THROWN live reading as silence, not as an absent agent', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      liveSession: { ask: () => Promise.reject(new Error('stdin gone')) },
    });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('did not answer');
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
      costedTurns: 2,
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
