import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpListingResult,
  AgentMcpServer,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentMcpListingWire } from '../chat.types';
import { resolveAgentVersion } from '../utils/agent-version';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { McpSettingsStore } from './mcp-settings.store';
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
 * Why a row carries no switch. Both are probe-verified limits of the CLI, not
 * choices this app made, so each says what is true rather than "unavailable".
 */
const NOT_PROJECT_SCOPE_REASON =
  'only servers defined in this folder\u2019s .mcp.json can be switched off';
const USER_DISABLED_REASON =
  'switched off in your own claude settings, which geniro cannot re-enable';

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
    private readonly settings: McpSettingsStore,
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
      return this.toWire(adapter, agent, projectDir, await pending);
    }
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return this.toWire(adapter, agent, projectDir, {
        ok: true,
        servers: cached.servers,
      });
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
    return this.toWire(adapter, agent, projectDir, await ask);
  }

  /**
   * Switch one server on or off for one agent in one folder.
   *
   * Refuses anything it cannot actually change, rather than writing a setting
   * that would have no effect: only a project-scope server can be disabled at
   * all, and one the user disabled in their OWN settings can never be
   * re-enabled from here, because the CLI unions the two lists rather than
   * letting geniro's override theirs. A silent no-op is the exact failure the
   * design forbids — the user would watch a switch move and the next turn
   * would ignore it.
   *
   * Answers with the freshly-composed listing, so the caller renders the state
   * that actually landed rather than the one it asked for.
   */
  async setEnabled(
    agent: AgentKind,
    cwd: string,
    server: string,
    enabled: boolean,
  ): Promise<AgentMcpListingWire> {
    const projectDir = resolveValidCwd(cwd);
    const adapter = this.adapters.for(agent);
    const unavailableReason = adapter.getConfig().mcp.listingUnavailableReason;
    if (unavailableReason !== null) {
      throw new BadRequestException(
        'MCP_TOGGLE_UNSUPPORTED',
        `${agent} cannot be told which MCP servers to load: ${unavailableReason}`,
      );
    }
    const facts = await adapter.readMcpFolderFacts(projectDir);
    if (!facts.projectServers.includes(server)) {
      throw new BadRequestException(
        'MCP_SERVER_NOT_TOGGLEABLE',
        `${server} is not a project-scope server in ${projectDir}, so it cannot be switched — ${NOT_PROJECT_SCOPE_REASON}`,
      );
    }
    if (enabled && facts.userDisabled.includes(server)) {
      throw new BadRequestException(
        'MCP_SERVER_DISABLED_BY_USER',
        `${server} is ${USER_DISABLED_REASON}`,
      );
    }
    await this.settings.setDisabled(agent, projectDir, server, !enabled);
    return this.list(agent, projectDir);
  }

  /**
   * Compose the wire listing: the adapter's rows, plus what the CLI's own
   * config files say about each one.
   *
   * The overlay is applied on EVERY exit path — cache hit, single-flight join,
   * and fresh read alike — because the disabled set and the project config
   * change independently of the health reading. Decorating only the fresh path
   * would leave a toggled row reading its old state for the rest of the
   * listing's five-minute TTL.
   *
   * The adapter's refusal becomes the sentence the panel shows, verbatim.
   */
  private async toWire(
    adapter: AgentAdapter,
    agent: AgentKind,
    cwd: string,
    result: AgentMcpListingResult,
  ): Promise<AgentMcpListingWire> {
    if (!result.ok) {
      return { servers: [], unavailableReason: result.reason };
    }
    const [facts, disabledByGeniro] = await Promise.all([
      adapter.readMcpFolderFacts(cwd).catch((err: unknown) => {
        // Reading the user's own files is best-effort. Knowing nothing means
        // every row renders read-only, which is the safe direction: a switch
        // that cannot work is worse than no switch.
        this.logger.warn(
          `reading ${agent} MCP folder facts failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { projectServers: [], userDisabled: [] };
      }),
      this.settings.disabled(agent, cwd),
    ]);
    const geniroDisabled = new Set(disabledByGeniro);
    const userDisabled = new Set(facts.userDisabled);
    const projectServers = new Set(facts.projectServers);
    return {
      servers: result.servers.map((server) => {
        const isProject = projectServers.has(server.name);
        const disabledByUser = userDisabled.has(server.name);
        return {
          ...server,
          scope: isProject ? ('project' as const) : ('other' as const),
          disabled: disabledByUser || geniroDisabled.has(server.name),
          toggleUnavailableReason: !isProject
            ? NOT_PROJECT_SCOPE_REASON
            : disabledByUser
              ? USER_DISABLED_REASON
              : null,
        };
      }),
      unavailableReason: null,
    };
  }
}
