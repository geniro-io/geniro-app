import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import type {
  AgentTurnHandle,
  AgentTurnInput,
  AgentUsage,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { runTagEnv } from '../utils/run-process-scan';
import { AgentEventBus } from './agent-events.bus';
import { ProcessRegistry } from './process-registry';
import { currentRunOwner } from './run-process-attribution.service';

export const PROMPT_CACHE_KEEP_ALIVE_MIN_CONTEXT_TOKENS = 50_000;
export const PROMPT_CACHE_KEEP_ALIVE_MAX_WARMUPS = 10;
export const PROMPT_CACHE_KEEP_ALIVE_MIN_LEAD_MS = 90_000;
export const PROMPT_CACHE_KEEP_ALIVE_LEAD_SHARE = 0.1;
export const PROMPT_CACHE_KEEP_ALIVE_MIN_REMAINING_MS = 30_000;
export const PROMPT_CACHE_WARMUP_TIMEOUT_MS = 120_000;
export const PROMPT_CACHE_WARMUP_MISS_MIN_TOKENS = 20_000;
export const PROMPT_CACHE_WARMUP_MISS_SHARE = 0.1;
export const PROMPT_CACHE_WARMUP_PROMPT = 'Reply with the single word: ok';

export interface PromptCacheWarmupTarget {
  runId: string;
  conversation: string;
  adapter: AgentAdapter;
  input: AgentTurnInput;
  sessionId: string;
  endedAt: number;
  promptCacheTtlMs: number | null;
  contextTokens: number | null;
  owed: () => boolean;
  onWarmed: (usage: AgentUsage) => void;
}

interface Warming {
  target: PromptCacheWarmupTarget;
  ttlMs: number;
  cachedUntil: number;
  warmups: number;
  timer: NodeJS.Timeout | null;
  handle: AgentTurnHandle | null;
}

export function warmupLeadMs(ttlMs: number): number {
  return Math.max(
    PROMPT_CACHE_KEEP_ALIVE_MIN_LEAD_MS,
    ttlMs * PROMPT_CACHE_KEEP_ALIVE_LEAD_SHARE,
  );
}

export function warmupMissed(
  usage: AgentUsage,
  contextTokens: number,
): boolean {
  return (
    (usage.cacheCreationTokens ?? 0) >
    Math.max(
      PROMPT_CACHE_WARMUP_MISS_MIN_TOKENS,
      contextTokens * PROMPT_CACHE_WARMUP_MISS_SHARE,
    )
  );
}

@Injectable()
export class PromptCacheKeepAliveService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PromptCacheKeepAliveService.name);
  private readonly warming = new Map<string, Warming>();
  private readonly runOwner = currentRunOwner();

  constructor(
    private readonly processes: ProcessRegistry,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => this.stopRun(runId));
    this.bus.allChanged().subscribe((runs) => {
      for (const run of runs) {
        if (run.archivedAt !== null) {
          this.stopRun(run.id);
        }
      }
    });
  }

  onApplicationShutdown(): void {
    for (const key of [...this.warming.keys()]) {
      this.stopKey(key);
    }
  }

  keepWarm(target: PromptCacheWarmupTarget): void {
    const key = keyOf(target.runId, target.conversation);
    this.stopKey(key);
    const ttlMs = target.promptCacheTtlMs;
    if (
      target.adapter.getConfig().promptCacheWarmupUnavailableReason !== null ||
      ttlMs === null ||
      ttlMs <= 0 ||
      (target.contextTokens ?? 0) < PROMPT_CACHE_KEEP_ALIVE_MIN_CONTEXT_TOKENS
    ) {
      return;
    }
    const warming: Warming = {
      target,
      ttlMs,
      cachedUntil: target.endedAt + ttlMs,
      warmups: 0,
      timer: null,
      handle: null,
    };
    this.warming.set(key, warming);
    this.schedule(key, warming);
  }

  stop(runId: string, conversation: string): void {
    this.stopKey(keyOf(runId, conversation));
  }

  stopRun(runId: string): void {
    for (const [key, warming] of [...this.warming]) {
      if (warming.target.runId === runId) {
        this.stopKey(key);
      }
    }
  }

  isWarming(runId: string, conversation: string): boolean {
    return this.warming.has(keyOf(runId, conversation));
  }

  private schedule(key: string, warming: Warming): void {
    const at = warming.cachedUntil - warmupLeadMs(warming.ttlMs);
    warming.timer = setTimeout(
      () => this.warm(key, warming),
      Math.max(0, at - Date.now()),
    );
    warming.timer.unref?.();
  }

  private warm(key: string, warming: Warming): void {
    warming.timer = null;
    if (this.warming.get(key) !== warming) {
      return;
    }
    const startedAt = Date.now();
    if (
      startedAt >
        warming.cachedUntil - PROMPT_CACHE_KEEP_ALIVE_MIN_REMAINING_MS ||
      warming.warmups >= PROMPT_CACHE_KEEP_ALIVE_MAX_WARMUPS ||
      !this.stillOwed(warming)
    ) {
      this.stopKey(key);
      return;
    }
    const { target } = warming;
    let usage: AgentUsage | null = null;
    let handle: AgentTurnHandle;
    try {
      handle = target.adapter.start(
        {
          ...target.input,
          prompt: PROMPT_CACHE_WARMUP_PROMPT,
          images: undefined,
          resumeSessionId: target.sessionId,
          promptCacheWarmup: true,
        },
        (event) => {
          if (event.type === 'turn_complete') {
            usage = event.usage;
          }
        },
        runTagEnv(target.runId, this.runOwner),
      );
    } catch (err) {
      this.logger.warn(
        `run ${target.runId}: could not start a prompt-cache warm-up: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.stopKey(key);
      return;
    }
    warming.handle = handle;
    this.processes.register(
      `prompt-cache-warmup:${target.runId}:${randomUUID()}`,
      handle,
    );
    const deadline = setTimeout(
      () => handle.cancel(),
      PROMPT_CACHE_WARMUP_TIMEOUT_MS,
    );
    deadline.unref?.();
    void handle.done
      .catch(() => undefined)
      .then(() => {
        clearTimeout(deadline);
        this.settle(key, warming, handle, startedAt, usage);
      });
  }

  private settle(
    key: string,
    warming: Warming,
    handle: AgentTurnHandle,
    startedAt: number,
    usage: AgentUsage | null,
  ): void {
    if (usage !== null) {
      try {
        warming.target.onWarmed(usage);
      } catch (err) {
        this.logger.warn(
          `run ${warming.target.runId}: could not record a prompt-cache warm-up's spend: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.warming.get(key) !== warming || warming.handle !== handle) {
      return;
    }
    warming.handle = null;
    warming.warmups += 1;
    if (
      usage === null ||
      warmupMissed(usage, warming.target.contextTokens ?? 0)
    ) {
      this.stopKey(key);
      return;
    }
    warming.ttlMs = usage.promptCacheTtlMs ?? warming.ttlMs;
    warming.cachedUntil = startedAt + warming.ttlMs;
    this.schedule(key, warming);
  }

  private stillOwed(warming: Warming): boolean {
    try {
      return warming.target.owed();
    } catch {
      return false;
    }
  }

  private stopKey(key: string): void {
    const warming = this.warming.get(key);
    if (warming === undefined) {
      return;
    }
    this.warming.delete(key);
    if (warming.timer !== null) {
      clearTimeout(warming.timer);
    }
    warming.handle?.cancel();
  }
}

function keyOf(runId: string, conversation: string): string {
  return `${runId}\u0000${conversation}`;
}
