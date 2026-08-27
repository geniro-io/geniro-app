import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentModelWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ModelVocabularyStore } from './model-vocabulary.store';
import { ProcessRegistry } from './process-registry';

/** Constructor options — test seams, not user config. */
export interface ModelsServiceOptions {
  /** How long a cached answer stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
}

interface CacheEntry {
  version: string | null;
  fetchedAt: number;
  models: AgentModelWire[];
}

/**
 * Re-ask no more than this often. The list only moves when the CLI or the
 * account changes, and asking cursor costs a process spawn.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * The composer's model list, per agent kind.
 *
 * Every CLI-specific detail lives in that CLI's adapter (`listModels`) — this
 * service only decides WHEN to ask and remembers the answer. It is keyed by
 * `<binary> --version` on top of a TTL, the same key the probe services use,
 * so upgrading a CLI surfaces its new models without a daemon restart.
 *
 * The memory cache above is joined by a DURABLE one
 * ({@link ModelVocabularyStore}), because the two answer different questions:
 * a TTL stops this process asking twice, and cursor's listing is a real ACP
 * handshake — so switching the composer to that CLI on a cold daemon sat on it,
 * every launch, for a list that had not changed in weeks. The store's own doc
 * block carries the three invalidation mechanisms; what this service adds is
 * the refresh BEHIND the answer, joined through the same `inFlight` map that
 * already stops two panes spawning two process groups.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private readonly cache = new Map<AgentKind, CacheEntry>();
  /**
   * Cold reads already running, keyed by agent — the same single-flight
   * `AgentMcpService` keeps, needed here now for the same reason: listing
   * cursor's models SPAWNS a CLI process group, so two chat panes mounting
   * their model chip at once would otherwise launch two of them for one
   * account-level answer. Omitting it was safe only while every adapter
   * answered from memory or a file.
   */
  private readonly inFlight = new Map<AgentKind, Promise<AgentModelWire[]>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    private readonly store: ModelVocabularyStore,
    options: ModelsServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async list(kind: AgentKind): Promise<AgentModelWire[]> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `models:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    const cached = this.cache.get(kind);
    if (
      cached &&
      cached.version === version &&
      this.now() - cached.fetchedAt < this.ttlMs
    ) {
      return cached.models;
    }
    // The DURABLE cache, consulted before anything is spawned. Its answer also
    // seeds the memory entry above, so the reads inside the next TTL cost
    // neither a disk map lookup nor a version compare.
    const stored = this.store.read(kind, null, version, isModelList);
    if (stored !== null) {
      // Seeded with the CURRENT time, not `stored.fetchedAt`: this is a fresh
      // memory reading of an answer that was already judged fresh enough to
      // serve (the store's own staleness check, below), so the TTL clock
      // starts now. Seeding it with the disk timestamp had every entry older
      // than the TTL but younger than the store's own revalidate window fail
      // the memory check on EVERY call — the disk read and shape walk re-ran
      // per request instead of the intended one-per-TTL-window.
      this.cache.set(kind, {
        version,
        fetchedAt: this.now(),
        models: stored.value,
      });
      if (stored.stale) {
        this.revalidate(kind, version, cached);
      }
      return stored.value;
    }
    // Joined AFTER the cache check, so a fresh answer still costs nothing.
    const running = this.inFlight.get(kind);
    if (running) {
      return running;
    }
    const pending = this.fetch(kind, version, cached);
    this.inFlight.set(kind, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(kind);
    }
  }

  /**
   * Forget every cached listing, and say how many went — see
   * `CacheResetService`. The DURABLE half is cleared by that service too, and
   * separately: this map is one process's memory of the same answers.
   */
  clearCache(): number {
    const dropped = this.cache.size;
    this.cache.clear();
    return dropped;
  }

  /**
   * Re-ask behind an answer already given.
   *
   * Through the SAME `inFlight` map a cold read uses, which is the whole
   * concurrency argument: a refresh cannot race a cold ask, and a second read
   * arriving while one is running joins it instead of spawning a second CLI.
   * `fetch` never rejects, so nothing here can surface as an unhandled
   * rejection from a promise nobody awaits.
   */
  private revalidate(
    kind: AgentKind,
    version: string | null,
    cached: CacheEntry | undefined,
  ): void {
    if (this.inFlight.has(kind)) {
      return;
    }
    const pending = this.fetch(kind, version, cached);
    this.inFlight.set(kind, pending);
    void pending.finally(() => this.inFlight.delete(kind));
  }

  private async fetch(
    kind: AgentKind,
    version: string | null,
    cached: CacheEntry | undefined,
  ): Promise<AgentModelWire[]> {
    const adapter: AgentAdapter = this.adapters.for(kind);
    let models: AgentModelWire[];
    try {
      models = await adapter.listModels({
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `models:list:${randomUUID()}`,
            // Taken from the spawn, not restated: this is the one converted
            // site that IS handed the real value, so hand-writing `false` here
            // is the exact drift the required parameter exists to prevent.
            childProcessHandle(child, spawnInfo),
          ),
      });
    } catch (err) {
      // An adapter must not throw here, but a picker with no rows is a dead
      // control — keep the last good answer rather than propagate.
      this.logger.warn(
        `listing ${kind} models failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return cached?.models ?? [];
    }
    this.cache.set(kind, { version, fetchedAt: this.now(), models });
    // An EMPTY list is deliberately not filed: every adapter answers one when
    // it could not ask, so storing it would re-serve "this CLI has no models"
    // for as long as the entry stood — the same rule the cursor adapter applies
    // to a reply that enumerated nothing.
    if (models.length > 0) {
      this.store.remember(kind, null, version, models);
    }
    return models;
  }
}

/**
 * What a stored listing has to look like to be served back.
 *
 * The store holds JSON, and this file outlives the build that wrote it — so a
 * row whose shape has since changed is exactly what a durable cache hands back,
 * and this is the difference between re-asking and giving the picker rows it
 * cannot render.
 */
function isModelList(value: unknown): value is AgentModelWire[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AgentModelWire).id === 'string' &&
        typeof (entry as AgentModelWire).label === 'string',
    )
  );
}
