import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentModelWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
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
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private readonly cache = new Map<AgentKind, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    options: ModelsServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async list(kind: AgentKind): Promise<AgentModelWire[]> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child) =>
        this.processes.register(
          `models:version:${randomUUID()}`,
          childProcessHandle(child, { processGroup: false }),
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
    return models;
  }
}
