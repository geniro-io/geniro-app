import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentEffortListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ProcessRegistry } from './process-registry';

/** Constructor options — test seams, not user config. */
export interface EffortsServiceOptions {
  /** How long a cached answer stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
}

interface CacheEntry {
  version: string | null;
  fetchedAt: number;
  listing: AgentEffortListingWire;
}

/**
 * Re-ask no more than this often. A model's effort axis moves when the CLI or
 * the account changes, and asking cursor costs a real handshake.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * The composer's reasoning-effort list, per agent kind AND per model.
 *
 * Nothing here knows what a level is called or which CLI has any — that is the
 * adapter's (`listModelEfforts`). This service only routes the question and
 * remembers the answer, exactly as {@link ModelsService} does for models.
 *
 * It gained a cache when it gained the model, and the two arrived together for
 * one reason: the levels turned out to be a property of the MODEL rather than
 * of the CLI (cursor's `grok-4.6` has no `max`, `auto-smart` no effort axis at
 * all), so answering exactly now means asking the binary — where before every
 * adapter answered from a documented constant and there was nothing to go
 * stale. The key carries the model for the same reason `ModelsService` carries
 * the version: two models genuinely have different answers.
 *
 * An EMPTY list is a real answer, not a failure — a CLI with no effort control,
 * or a model with none — and it always arrives with the sentence saying which.
 */
@Injectable()
export class EffortsService {
  private readonly logger = new Logger(EffortsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * Cold reads already running, keyed the same way as the cache. The same
   * single-flight `ModelsService` keeps, and needed here for the same reason:
   * a cursor listing SPAWNS a CLI process group, so a composer and a graph
   * inspector mounting their effort chip at once would otherwise launch two of
   * them for one answer.
   */
  private readonly inFlight = new Map<
    string,
    Promise<AgentEffortListingWire>
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    options: EffortsServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async list(
    kind: AgentKind,
    model: string | null = null,
  ): Promise<AgentEffortListingWire> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `efforts:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    const key = this.keyFor(kind, model);
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.version === version &&
      this.now() - cached.fetchedAt < this.ttlMs
    ) {
      return cached.listing;
    }
    // Joined AFTER the cache check, so a fresh answer still costs nothing.
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const pending = this.fetch(kind, model, key, version, cached);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Whether a run may be created carrying this effort.
   *
   * Synchronous on purpose: this is the daemon's refusal at run CREATION, and
   * gating it on a multi-second per-model handshake would make starting a chat
   * wait on a question the picker asks.
   *
   * What it checks against is the ADAPTER's own answer about its list
   * (`effortsAreExhaustive`), never the list alone — and that distinction is a
   * defect this shipped. A CLI whose levels belong to the BINARY has a complete
   * list, so a word outside it is one the CLI would ignore in silence and
   * refusing is the only way the user hears about it. A CLI whose levels belong
   * to the MODEL has only a union, and checking it exhaustively refused
   * `extra-high` — a real level `gpt-5.2` offers and the picker had just shown,
   * so the chat could not be started at all. There, the turn's own driver
   * checks the value against the model that will run it and reports what does
   * not apply, which is both more accurate and current.
   *
   * A CLI with NO effort control refuses every level either way: its list is
   * empty and exhaustive.
   */
  accepts(kind: AgentKind, effort: string): boolean {
    const adapter = this.adapterFor(kind);
    const levels = adapter.listEfforts();
    if (!adapter.getConfig().effortsAreExhaustive) {
      // Still refused when the CLI has no effort control at all — an empty list
      // is not an incomplete one, it is the absence of the axis.
      return levels.length > 0;
    }
    return levels.some((e) => e.id === effort);
  }

  /** `(agent, model)` — a null model is its own key, not a missing one. */
  private keyFor(kind: AgentKind, model: string | null): string {
    return `${kind}\u0000${model ?? ''}`;
  }

  private async fetch(
    kind: AgentKind,
    model: string | null,
    key: string,
    version: string | null,
    cached: CacheEntry | undefined,
  ): Promise<AgentEffortListingWire> {
    const adapter: AgentAdapter = this.adapters.for(kind);
    let listing: AgentEffortListingWire;
    try {
      listing = await adapter.listModelEfforts(model, {
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `efforts:list:${randomUUID()}`,
            childProcessHandle(child, spawnInfo),
          ),
      });
    } catch (err) {
      // An adapter must not throw here, but a picker with no rows is a dead
      // control — keep the last good answer rather than propagate.
      this.logger.warn(
        `listing ${kind} efforts failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return (
        cached?.listing ?? {
          efforts: [...adapter.listEfforts()],
          unavailableReason: adapter.getConfig().effortsUnavailableReason,
        }
      );
    }
    this.cache.set(key, { version, fetchedAt: this.now(), listing });
    return listing;
  }

  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }
}
