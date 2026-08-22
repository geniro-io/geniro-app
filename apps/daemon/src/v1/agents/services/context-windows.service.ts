import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentContextWindowListing } from '../adapters/adapter.types';
import type { AgentContextWindowListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { ModelVocabularyCache } from '../utils/model-vocabulary-cache';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ProcessRegistry } from './process-registry';

/** Constructor options — test seams, not user config. */
export interface ContextWindowsServiceOptions {
  /** How long a cached answer stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
}

/**
 * The same window the effort listing uses, and for the same reason: the answer
 * moves only when the CLI or the account changes, and asking cursor costs a
 * real handshake.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Which context-window sizes ONE MODEL of a CLI can be run at.
 *
 * Nothing here knows what a window size is called or which CLI offers the axis
 * — that is `AgentAdapter.listModelContextWindows`. This service routes the
 * question, caches the answer per (CLI, model, binary version), and never asks
 * twice at once (`ModelVocabularyCache`, shared with the effort listing).
 *
 * **It is per MODEL, necessarily.** Probed 2026-08-21 across every model a
 * cursor account offers: twelve of thirty-four carry the setting, and their
 * vocabularies differ — `300k|1m`, `272k|1m`, `200k|1m` — while the rest have
 * no such axis at all. So there is no CLI-wide list to serve, and unlike the
 * effort listing there is no superset to fall back on either: a window size
 * means nothing apart from the model it belongs to.
 *
 * An EMPTY list is a real answer, not a failure, and always arrives with the
 * sentence saying which of the three cases it is — this model has one fixed
 * window, this CLI has no such control, or the CLI could not be asked.
 */
@Injectable()
export class ContextWindowsService {
  private readonly logger = new Logger(ContextWindowsService.name);
  private readonly cache: ModelVocabularyCache<AgentContextWindowListing>;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    options: ContextWindowsServiceOptions = {},
  ) {
    this.cache = new ModelVocabularyCache({
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? Date.now,
    });
  }

  async list(
    kind: AgentKind,
    model: string | null = null,
  ): Promise<AgentContextWindowListing> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `context-windows:version:${randomUUID()}`,
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
  ): Promise<AgentContextWindowListingWire> {
    const listing = await this.list(kind, model);
    return {
      windows: listing.windows,
      unavailableReason: listing.unavailableReason,
    };
  }

  private async fetch(
    kind: AgentKind,
    model: string | null,
    previous: AgentContextWindowListing | undefined,
  ): Promise<AgentContextWindowListing> {
    const adapter = this.adapters.for(kind);
    try {
      return await adapter.listModelContextWindows(model, {
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `context-windows:list:${randomUUID()}`,
            childProcessHandle(child, spawnInfo),
          ),
      });
    } catch (err) {
      // An adapter must not throw here, but a picker with no rows is a dead
      // control — keep the last good answer rather than propagate.
      this.logger.warn(
        `listing ${kind} context windows failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return (
        previous ?? {
          windows: [],
          unavailableReason:
            adapter.getConfig().contextWindowsUnavailableReason ??
            `${kind} could not be asked which context windows this model offers`,
          exact: false,
        }
      );
    }
  }
}
