import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import type { AgentModelWire } from '../chat.types';
import { resolveAgentVersion } from '../utils/agent-version';
import { childProcessHandle } from '../utils/child-handle';
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
    private readonly claude: ClaudeAdapter,
    private readonly cursor: CursorAdapter,
    private readonly processes: ProcessRegistry,
    options: ModelsServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async list(kind: AgentKind): Promise<AgentModelWire[]> {
    const version = await resolveAgentVersion(kind, {
      onSpawn: (child) =>
        this.processes.register(
          `models:version:${randomUUID()}`,
          childProcessHandle(child),
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
    const adapter: AgentAdapter = kind === 'claude' ? this.claude : this.cursor;
    let models: AgentModelWire[];
    try {
      models = await adapter.listModels({
        onSpawn: (child) =>
          this.processes.register(
            `models:list:${randomUUID()}`,
            childProcessHandle(child),
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
