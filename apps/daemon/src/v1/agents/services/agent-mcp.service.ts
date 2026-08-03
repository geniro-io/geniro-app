import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpListingResult,
  AgentMcpServer,
} from '../adapters/adapter.types';
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

/** Shown when the adapter itself misbehaved rather than the CLI refusing. */
const MCP_LIST_FAILED_REASON = 'could not read MCP servers';

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
export interface AgentMcpServiceOptions {
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
 * `Agent`-prefixed deliberately: `v1/graphs` owns `McpServerService`, which is
 * the daemon's OWN MCP endpoint that agents call INTO. This one is the
 * opposite direction — the user's own servers that an agent loads — and a bare
 * `McpService` next to it reads as the same subsystem.
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
export class AgentMcpService {
  private readonly logger = new Logger(AgentMcpService.name);
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveVersionFn: typeof resolveAgentVersion;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AgentMcpListingResult>>();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    options: AgentMcpServiceOptions = {},
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
    // Validated FIRST, so a bad cwd is a bad request whichever adapter answers.
    // Below the refusal it would be, and a folder that 400s for claude today
    // would start 400ing for cursor the day cursor gains a listing.
    const projectDir = resolveValidCwd(cwd);
    const adapter = this.adapters.for(agent);
    // The adapter's own sentence, carried through untouched. A CLI that cannot
    // be listed is not asked at all — spawning it to receive a guaranteed
    // empty answer would health-check nothing and cost a process.
    const unavailableReason = adapter.getConfig().mcp.listingUnavailableReason;
    if (unavailableReason !== null) {
      return { servers: [], unavailableReason };
    }
    const version = await this.resolveVersionFn(agent, {
      onSpawn: (child) =>
        this.processes.register(
          `mcp:version:${randomUUID()}`,
          childProcessHandle(child, { processGroup: false }),
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
      return this.toWire(await pending);
    }
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return { servers: cached.servers, unavailableReason: null };
    }
    // `Promise.resolve().then(…)` rather than a bare call: an adapter that
    // throws SYNCHRONOUSLY would otherwise walk straight past the `.catch`
    // below and reject the whole request, which this read must never do.
    const ask = Promise.resolve()
      .then(() =>
        adapter.listMcpServers(
          { cwd: projectDir },
          {
            onSpawn: (child, spawnInfo) =>
              this.processes.register(
                `mcp:list:${randomUUID()}`,
                // `spawnInfo` comes from the spawn itself, so a group-spawned
                // listing is always reaped as a group — the user's own MCP
                // servers run one generation below it.
                childProcessHandle(child, spawnInfo),
              ),
          },
        ),
      )
      .catch((err: unknown): AgentMcpListingResult => {
        // An adapter must not throw here, but this feeds a panel — degrade to
        // a refusal rather than failing the request.
        this.logger.warn(
          `listing ${agent} MCP servers failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, reason: MCP_LIST_FAILED_REASON };
      })
      .then((result) => {
        // ONLY a successful read is remembered. "No servers" is a claim about
        // the user's configuration; caching a failure would turn one timeout
        // into five minutes of the panel asserting something untrue, with no
        // automatic way back. `ModelsService` keeps its last good answer for
        // the same reason.
        if (result.ok) {
          this.cache.set(key, {
            fetchedAt: this.now(),
            servers: result.servers,
          });
        }
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, ask);
    return this.toWire(await ask);
  }

  /** The adapter's refusal becomes the sentence the panel shows, verbatim. */
  private toWire(result: AgentMcpListingResult): AgentMcpListingWire {
    return result.ok
      ? { servers: result.servers, unavailableReason: null }
      : { servers: [], unavailableReason: result.reason };
  }
}
