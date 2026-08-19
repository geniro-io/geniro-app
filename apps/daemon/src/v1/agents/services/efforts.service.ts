import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentEffortListing } from '../adapters/adapter.types';
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
  listing: AgentEffortListing;
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
  private readonly inFlight = new Map<string, Promise<AgentEffortListing>>();
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
  ): Promise<AgentEffortListing> {
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
   * What it checks against is the ADAPTER's own answer about its list
   * (`effortsAreExhaustive`), never the list alone. A CLI whose levels belong
   * to the BINARY has a complete list, so a word outside it is one the CLI
   * would ignore in silence and refusing is the only way the user hears about
   * it. A CLI whose levels belong to the MODEL has only a union, and checking
   * THAT exhaustively refused `extra-high` — a real level `gpt-5.2` offers and
   * the picker had just shown — so the chat could not be started at all.
   *
   * For that second kind the MODEL's own listing is what can answer exactly —
   * but only a listing this service ALREADY HOLDS. Synchronous on purpose, and
   * that is the whole design: asking here would put a multi-second CLI
   * handshake inside `POST /v1/chats`, so a run started from a saved
   * configuration would wait on a question the picker asks. The picker is
   * normally what warmed the entry, since choosing the model is what fetches
   * its levels; a cold cache simply answers leniently and the turn's own driver
   * reports what does not apply.
   *
   * A refusal is grounded ONLY on `AgentEffortListing.exact` — the listing's own
   * statement that it came from the named model rather than standing in for it.
   * Watching for a failure instead cannot work: every fallback in the adapter
   * contract RESOLVES with the CLI-wide superset (a probe that times out, and
   * equally a reply that enumerated nothing), so a caller sees a perfectly
   * successful listing either way. Refusing on one rejects `extra-high` — a
   * real `gpt-5.2` level the picker had just offered — whenever the CLI merely
   * could not be asked, which is the defect this leniency exists to prevent.
   *
   * With no model named there is nothing better to consult, so the answer
   * stands lenient there too.
   *
   * A CLI with NO effort control refuses every level either way: its list is
   * empty and exhaustive.
   */
  accepts(
    kind: AgentKind,
    effort: string,
    model: string | null = null,
  ): boolean {
    const adapter = this.adapterFor(kind);
    const levels = adapter.listEfforts();
    if (adapter.getConfig().effortsAreExhaustive) {
      return levels.some((e) => e.id === effort);
    }
    // An empty list is not an incomplete one, it is the absence of the axis.
    if (levels.length === 0) {
      return false;
    }
    if (model === null) {
      return true;
    }
    const known = this.freshCachedListing(kind, model);
    // Nothing held, a listing standing in for the model's own answer, or a
    // model with no effort axis at all — none is evidence that the level is
    // wrong, only that nothing here can say so.
    if (known === null || !known.exact || known.efforts.length === 0) {
      return true;
    }
    return known.efforts.some((e) => e.id === effort);
  }

  /**
   * A cached listing still inside its TTL, or null.
   *
   * The `--version` key {@link list} also checks is deliberately not consulted:
   * resolving it spawns, and this is the synchronous path. A CLI upgraded
   * within the TTL is the one case that can answer from a previous binary's
   * vocabulary — bounded, and in the lenient direction far more often than not.
   */
  private freshCachedListing(
    kind: AgentKind,
    model: string,
  ): AgentEffortListing | null {
    const entry = this.cache.get(this.keyFor(kind, model));
    if (!entry || this.now() - entry.fetchedAt >= this.ttlMs) {
      return null;
    }
    return entry.listing;
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
  ): Promise<AgentEffortListing> {
    const adapter: AgentAdapter = this.adapters.for(kind);
    let listing: AgentEffortListing;
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
          // The union standing in for an answer nobody could get — a picker
          // takes it, a refusal must not.
          exact: false,
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
