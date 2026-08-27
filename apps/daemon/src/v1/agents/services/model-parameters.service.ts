import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentModelParameterListing } from '../adapters/adapter.types';
import type { AgentModelParameterListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import {
  ModelVocabularyCache,
  volatile,
  type VolatileAnswer,
} from '../utils/model-vocabulary-cache';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ProcessRegistry } from './process-registry';

/** Constructor options — test seams, not user config. */
export interface ModelParametersServiceOptions {
  /** How long a cached answer stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
}

/**
 * The same window the two listings beside it use, and for the same reason: the
 * answer moves only when the CLI or the account changes, and asking cursor
 * costs a real handshake.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Every setting of ONE model that geniro has no dedicated control for.
 *
 * The third of three listings over one question — "what can this model be run
 * with" — and the only one that does not know its own answer in advance. The
 * effort and context services each ask the adapter for one axis they were
 * written knowing about; this one asks for whatever is left, so a parameter the
 * CLI adds next month reaches the user without a change here. What that left is
 * belongs entirely to `AgentAdapter.listModelParameters`; this service routes
 * the question, caches per (CLI, model, binary version), and never asks twice
 * at once (`ModelVocabularyCache`, shared with both siblings).
 *
 * An EMPTY list is a real answer and arrives with the sentence saying which
 * case it is — this model has nothing further, or the CLI could not be asked.
 * Unlike the two beside it there is no control to hang that sentence on: with
 * no parameters there is nothing to draw, so the reason is for the log and for
 * a caller that wants to explain itself.
 */
@Injectable()
export class ModelParametersService {
  private readonly logger = new Logger(ModelParametersService.name);
  private readonly cache: ModelVocabularyCache<AgentModelParameterListing>;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    private readonly options: ModelParametersServiceOptions = {},
  ) {
    this.cache = new ModelVocabularyCache({
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? Date.now,
    });
  }

  async list(
    kind: AgentKind,
    model: string | null = null,
  ): Promise<AgentModelParameterListing> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `model-parameters:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    return this.cache.read(kind, model, version, (previous) =>
      this.fetch(kind, model, previous),
    );
  }

  /** The wire shape — the listing plus nothing this route does not answer. */
  async listWire(
    kind: AgentKind,
    model: string | null = null,
  ): Promise<AgentModelParameterListingWire> {
    const listing = await this.list(kind, model);
    return {
      parameters: listing.parameters,
      unavailableReason: listing.unavailableReason,
    };
  }

  private async fetch(
    kind: AgentKind,
    model: string | null,
    previous: AgentModelParameterListing | undefined,
  ): Promise<
    AgentModelParameterListing | VolatileAnswer<AgentModelParameterListing>
  > {
    const adapter = this.adapters.for(kind);
    try {
      return await adapter.listModelParameters(model, {
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `model-parameters:list:${randomUUID()}`,
            childProcessHandle(child, spawnInfo),
          ),
      });
    } catch (err) {
      // An adapter must not throw here. Keep the last good answer rather than
      // propagate: losing the list costs the user every chip on the row.
      //
      // VOLATILE, so the cache serves this without storing it — nothing was
      // learned about the model, and remembering the stand-in would answer
      // every request for the rest of the TTL instead of re-asking on the next.
      this.logger.warn(
        `listing ${kind} model parameters failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const fallback: AgentModelParameterListing = previous ?? {
        parameters: [],
        unavailableReason: `${kind} could not be asked which settings this model offers`,
        exact: false,
      };
      return volatile(fallback);
    }
  }
  /**
   * Forget every cached model settings, and say how many went — see
   * `CacheResetService`.
   */
  clearCache(): number {
    return this.cache.clear();
  }
}
