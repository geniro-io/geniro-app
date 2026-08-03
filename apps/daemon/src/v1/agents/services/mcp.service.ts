import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentMcpServer } from '../adapters/adapter.types';
import type { AgentMcpListingWire } from '../chat.types';
import { resolveAgentVersion } from '../utils/agent-version';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { ProcessRegistry } from './process-registry';

/**
 * How long a listing stays fresh.
 *
 * Deliberately long for a health reading, because taking one is expensive: the
 * CLI dials every configured server, which for a stdio server means launching
 * the user's own process. The panel is not a monitor — an explicit Refresh is
 * what re-reads health, per this feature's design.
 */
const DEFAULT_MCP_TTL_MS = 5 * 60_000;

/**
 * The cache key. Three dimensions, and dropping any one of them serves a
 * confidently wrong answer rather than a stale one:
 *
 * - **agent** — the two CLIs read different config files entirely.
 * - **cwd** — the listing is folder-scoped (project `.mcp.json`, and
 *   local-scope servers keyed to that directory).
 * - **version** — an upgraded binary can reword the output the parser reads,
 *   so a listing is only reusable while the binary that produced it is.
 *
 * NUL-joined because it is the one byte a path cannot contain — the same key
 * shape `SkillHarvestStore` and the renderer's caches use.
 */
function keyOf(agent: AgentKind, cwd: string, version: string | null): string {
  return `${agent}\u0000${cwd}\u0000${version ?? ''}`;
}

/** Constructor options — test seams, not user config. */
export interface McpServiceOptions {
  /** How long a cached listing stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: typeof resolveAgentVersion;
}

interface CacheEntry {
  fetchedAt: number;
  servers: AgentMcpServer[];
}

/**
 * The MCP servers each agent loads in a folder, as the CLI itself reports
 * them.
 *
 * Every CLI-specific detail lives in that CLI's adapter — whether it can be
 * asked at all, what to run, and how to read the answer
 * (`AgentAdapter.listMcpServers`). This service only decides WHEN to ask: it
 * caches per (agent, cwd, version) on a TTL, and coalesces concurrent reads of
 * the same key onto one spawn.
 *
 * That coalescing matters more here than for the other vocabularies. Asking is
 * not merely slow — the CLI HEALTH-CHECKS, launching the user's own MCP
 * servers as it goes — so two panels opening at once must not mean two rounds
 * of that.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveVersionFn: typeof resolveAgentVersion;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AgentMcpServer[]>>();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    options: McpServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_MCP_TTL_MS;
    this.now = options.now ?? Date.now;
    this.resolveVersionFn = options.resolveVersionFn ?? resolveAgentVersion;
  }

  /**
   * One agent's servers in one folder. `refresh` drops the cached reading
   * first — the Refresh control's whole job, since nothing else re-dials a
   * server that has since come back up.
   */
  async list(
    agent: AgentKind,
    cwd: string,
    refresh = false,
  ): Promise<AgentMcpListingWire> {
    const adapter = this.adapters.for(agent);
    // The adapter's own sentence, carried through untouched. A CLI that cannot
    // be listed is not asked at all — spawning it to receive a guaranteed
    // empty answer would health-check nothing and cost a process.
    const unavailableReason = adapter.getConfig().mcp.listingUnavailableReason;
    if (unavailableReason !== null) {
      return { servers: [], unavailableReason };
    }
    const projectDir = resolveValidCwd(cwd);
    const version = await this.resolveVersionFn(agent, {
      onSpawn: (child) =>
        this.processes.register(
          `mcp:version:${randomUUID()}`,
          childProcessHandle(child),
        ),
    });
    const key = keyOf(agent, projectDir, version);
    if (refresh) {
      this.cache.delete(key);
    }
    // Single-flight is checked AFTER the refresh eviction on purpose: a
    // double-clicked Refresh should join the re-read already running, not
    // start a second one. Evicting the cache is idempotent; spawning is not.
    const pending = this.inFlight.get(key);
    if (pending) {
      return { servers: await pending, unavailableReason: null };
    }
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return { servers: cached.servers, unavailableReason: null };
    }
    const ask = adapter
      .listMcpServers(
        { cwd: projectDir },
        {
          onSpawn: (child) =>
            this.processes.register(
              `mcp:list:${randomUUID()}`,
              // Paired with the adapter's own `processGroup` spawn: the
              // listing forks the user's MCP servers, so cancel and shutdown
              // must reach the whole group, not just the CLI process.
              childProcessHandle(child, { processGroup: true }),
            ),
        },
      )
      .catch((err: unknown) => {
        // An adapter must not throw here, but this feeds a panel — degrade to
        // an empty list rather than failing the request.
        this.logger.warn(
          `listing ${agent} MCP servers failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as AgentMcpServer[];
      })
      .then((servers) => {
        this.cache.set(key, { fetchedAt: this.now(), servers });
        return servers;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, ask);
    return { servers: await ask, unavailableReason: null };
  }
}
