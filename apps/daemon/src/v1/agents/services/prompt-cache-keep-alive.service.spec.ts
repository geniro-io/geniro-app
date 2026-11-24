import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
  AgentUsage,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { RunWire } from '../chat.types';
import { AgentEventBus } from './agent-events.bus';
import { ProcessRegistry } from './process-registry';
import {
  PROMPT_CACHE_KEEP_ALIVE_MAX_WARMUPS,
  PROMPT_CACHE_WARMUP_PROMPT,
  PROMPT_CACHE_WARMUP_TIMEOUT_MS,
  PromptCacheKeepAliveService,
  type PromptCacheWarmupTarget,
} from './prompt-cache-keep-alive.service';

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;

interface Warmup {
  input: AgentTurnInput;
  runTag: Readonly<Record<string, string>> | undefined;
  cancelled: boolean;
  finish(usage: AgentUsage | null): void;
}

class FakeAdapter {
  readonly warmups: Warmup[] = [];

  constructor(private readonly unavailableReason: string | null = null) {}

  getConfig(): { promptCacheWarmupUnavailableReason: string | null } {
    return { promptCacheWarmupUnavailableReason: this.unavailableReason };
  }

  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
    runTag?: Readonly<Record<string, string>>,
  ): AgentTurnHandle {
    let resolve!: () => void;
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const warmup: Warmup = {
      input,
      runTag,
      cancelled: false,
      finish: (usage) => {
        onEvent({
          type: 'turn_complete',
          usage,
          stopReason: null,
          finalText: null,
        });
        resolve();
      },
    };
    this.warmups.push(warmup);
    return {
      done,
      cancel: () => {
        warmup.cancelled = true;
        resolve();
      },
      respondApproval: () => false,
      sendUserMessage: () => false,
      attributableDelegate: () => null,
      setApprovalMode: () => false,
    };
  }
}

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    inputTokens: 2,
    outputTokens: 5,
    cacheReadTokens: 150_000,
    cacheCreationTokens: 1_200,
    thinkingTokens: null,
    contextTokens: 151_200,
    contextWindowTokens: 1_000_000,
    contextModel: 'claude-opus-5-5',
    costUsd: 0.04,
    estimatedCostUsd: 0.04,
    durationMs: 3_000,
    apiMs: 2_000,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: 1,
    promptCacheTtlMs: FIVE_MINUTES,
    ...overrides,
  };
}

const leadInput: AgentTurnInput = {
  prompt: 'the lead’s last prompt',
  cwd: '/proj',
  model: 'claude-opus-5-5',
  images: [{ mediaType: 'image/png', path: '/tmp/shot.png' }],
  resumeSessionId: 'older-session',
};

describe('PromptCacheKeepAliveService', () => {
  let bus: AgentEventBus;
  let processes: ProcessRegistry;
  let service: PromptCacheKeepAliveService;
  let adapter: FakeAdapter;
  let owed: boolean;
  let warmed: AgentUsage[];

  function target(
    overrides: Partial<PromptCacheWarmupTarget> = {},
  ): PromptCacheWarmupTarget {
    return {
      runId: 'run-1',
      conversation: 'lead',
      adapter: adapter as unknown as AgentAdapter,
      input: leadInput,
      sessionId: 'lead-session',
      endedAt: Date.now(),
      promptCacheTtlMs: FIVE_MINUTES,
      contextTokens: 150_000,
      owed: () => owed,
      onWarmed: (spent) => warmed.push(spent),
      ...overrides,
    };
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new AgentEventBus();
    processes = new ProcessRegistry();
    service = new PromptCacheKeepAliveService(processes, bus);
    service.onModuleInit();
    adapter = new FakeAdapter();
    owed = true;
    warmed = [];
  });

  afterEach(() => {
    service.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('warms the lead’s own session before its five-minute cache lapses, and again after each warm-up', async () => {
    service.keepWarm(target());

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_001);
    expect(adapter.warmups).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.warmups).toHaveLength(1);
    const first = adapter.warmups[0]!;
    expect(first.input).toMatchObject({
      prompt: PROMPT_CACHE_WARMUP_PROMPT,
      resumeSessionId: 'lead-session',
      promptCacheWarmup: true,
      model: 'claude-opus-5-5',
      cwd: '/proj',
    });
    expect(first.input.images).toBeUndefined();
    expect(first.runTag).toMatchObject({ GENIRO_RUN_ID: 'run-1' });
    expect(
      processes
        .activeKeys()
        .some((key) => key.startsWith('prompt-cache-warmup:run-1:')),
    ).toBe(true);

    first.finish(usage());
    await settle();
    expect(warmed).toHaveLength(1);
    expect(processes.activeKeys()).toEqual([]);

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_001);
    expect(adapter.warmups).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.warmups).toHaveLength(2);
  });

  it('warms an hour-long cache ten percent of its life ahead of the expiry', async () => {
    service.keepWarm(target({ promptCacheTtlMs: ONE_HOUR }));

    await vi.advanceTimersByTimeAsync(ONE_HOUR * 0.9 - 1);
    expect(adapter.warmups).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.warmups).toHaveLength(1);
  });

  it('never warms a CLI that states no cache lifetime', async () => {
    adapter = new FakeAdapter(
      'cursor reports no prompt-cache lifetime, so there is no expiry to warm the cache ahead of',
    );
    service.keepWarm(target());

    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(0);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('never warms a turn that reported no cache lifetime, or a context too small to be worth it', async () => {
    service.keepWarm(target({ promptCacheTtlMs: null }));
    service.keepWarm(target({ conversation: 'small', contextTokens: 49_999 }));

    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(0);
  });

  it('sends nothing once nothing is owed to the lead — a lead waiting on the user', async () => {
    owed = false;
    service.keepWarm(target());

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(adapter.warmups).toHaveLength(0);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('stops when the lead’s own turn starts, before the warm-up and during one', async () => {
    service.keepWarm(target());
    service.stop('run-1', 'lead');
    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(0);

    service.keepWarm(target());
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
    expect(adapter.warmups).toHaveLength(1);
    service.stop('run-1', 'lead');
    expect(adapter.warmups[0]!.cancelled).toBe(true);
    await settle();
    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(1);
  });

  it('still counts the spend of a warm-up that finished after warming stopped', async () => {
    service.keepWarm(target());
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
    const inFlight = adapter.warmups[0]!;
    inFlight.finish(usage());
    service.stop('run-1', 'lead');
    await settle();

    expect(warmed).toHaveLength(1);
  });

  it('stops after the cap of warm-ups in one wait', async () => {
    service.keepWarm(target());
    for (let i = 0; i < PROMPT_CACHE_KEEP_ALIVE_MAX_WARMUPS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
      adapter.warmups.at(-1)?.finish(usage());
      await settle();
    }

    expect(adapter.warmups).toHaveLength(PROMPT_CACHE_KEEP_ALIVE_MAX_WARMUPS);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('stops after a warm-up that wrote the context instead of reading it', async () => {
    service.keepWarm(target());
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
    adapter.warmups[0]!.finish(
      usage({ cacheReadTokens: 0, cacheCreationTokens: 150_000 }),
    );
    await settle();

    expect(warmed).toHaveLength(1);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(1);
  });

  it('stops after a warm-up that ended with no reading', async () => {
    service.keepWarm(target());
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
    adapter.warmups[0]!.finish(null);
    await settle();

    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('cancels a warm-up that hangs past its deadline and stops warming', async () => {
    service.keepWarm(target());
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 90_000);
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_WARMUP_TIMEOUT_MS);

    expect(adapter.warmups[0]!.cancelled).toBe(true);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('sends nothing when the cache has already lapsed by the time the timer fires', async () => {
    service.keepWarm(target({ endedAt: Date.now() - FIVE_MINUTES + 20_000 }));

    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(0);
    expect(service.isWarming('run-1', 'lead')).toBe(false);
  });

  it('stops every conversation of a run that is archived or deleted', async () => {
    service.keepWarm(target());
    service.keepWarm(target({ runId: 'run-2' }));
    bus.publishRunsChanged([
      { id: 'run-1', archivedAt: '2026-11-22T10:00:00.000Z' } as RunWire,
    ]);
    bus.publishRunDeleted('run-2');

    await vi.advanceTimersByTimeAsync(ONE_HOUR);
    expect(adapter.warmups).toHaveLength(0);
  });
});
