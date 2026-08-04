import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpListingResult,
  AgentMcpServer,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentMcpListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { resolveValidPluginDir } from '../utils/resolve-plugin-dir';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
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
 * The directory a FOLDER-INDEPENDENT listing runs in, under userData.
 *
 * The graph builder has no folder: a workflow is edited long before it is run
 * in one. What it can honestly show is the set that does NOT depend on a
 * folder — the user's global servers plus whatever the node's own plugin
 * directory brings — and the way to get that from the CLI is to ask it
 * somewhere with no project config of its own, because a project `.mcp.json`
 * is visible ONLY from its own folder (probe-verified on claude 2.1.220).
 *
 * geniro owns this directory and keeps it empty, so "no project servers here"
 * is a property of the path rather than a hope about the user's disk. The
 * listing writes nothing — not even a `~/.claude.json` project entry
 * (probe-verified: that file's checksum is unchanged across one).
 */
const FOLDERLESS_DIR_NAME = 'mcp-folderless';

/**
 * The cache key. Four dimensions, and dropping any one of them serves a
 * confidently wrong answer rather than a stale one:
 *
 * - **agent** — the two CLIs read different config files entirely.
 * - **cwd** — the listing is folder-scoped (project `.mcp.json`, and
 *   local-scope servers keyed to that directory).
 * - **pluginDir** — a plugin ships its own MCP servers, so two nodes pointed
 *   at different directories genuinely have different sets. Sharing one cache
 *   entry between them is the exact failure this dimension exists to prevent.
 * - **version** — an upgraded binary can reword the output the parser reads,
 *   so a listing is only reusable while the binary that produced it is.
 *
 * NUL-joined because it is the one byte a path cannot contain — the same key
 * shape `SkillHarvestStore` and the renderer's caches use.
 */
function keyOf(
  agent: AgentKind,
  cwd: string,
  pluginDir: string | null,
  version: string | null,
): string {
  return `${agent}\u0000${cwd}\u0000${pluginDir ?? ''}\u0000${version ?? ''}`;
}

/** Constructor options — test seams, not user config. */
export interface AgentMcpServiceOptions {
  /** How long a cached listing stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: AgentVersionService['resolve'];
  /**
   * The empty directory a folder-independent listing runs in (test seam);
   * defaults to `<userData>/mcp-folderless`. A spec that let this default
   * through would create it in the real user's data directory.
   */
  folderlessDir?: string;
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
  private readonly resolveVersionFn: AgentVersionService['resolve'];
  private readonly folderlessDirPath: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AgentMcpListingResult>>();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly settings: McpSettingsStore,
    private readonly versions: AgentVersionService,
    options: AgentMcpServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_MCP_TTL_MS;
    this.now = options.now ?? Date.now;
    this.resolveVersionFn =
      options.resolveVersionFn ??
      ((kind, opts) => versions.resolve(kind, opts));
    this.folderlessDirPath =
      options.folderlessDir ??
      join(environment.userDataDir, FOLDERLESS_DIR_NAME);
  }

  /**
   * The empty directory a folder-independent listing runs in, created on
   * first use. Memoized only in the sense that `mkdirSync` with `recursive`
   * is a no-op once it exists.
   */
  private folderlessDir(): string {
    mkdirSync(this.folderlessDirPath, { recursive: true });
    return this.folderlessDirPath;
  }

  /**
   * One agent's servers in one folder. `refresh` drops the cached reading
   * first — the Refresh control's whole job, since nothing else re-dials a
   * server that has since come back up.
   */
  async list(
    agent: AgentKind,
    cwd: string | null,
    options: { pluginDir?: string | null; refresh?: boolean } = {},
  ): Promise<AgentMcpListingWire> {
    const { pluginDir = null, refresh = false } = options;
    // Validated FIRST, so a bad path is a bad request whichever adapter
    // answers — never a 400 for one CLI and a 200 for another. Ordering, not
    // just validation: placed BELOW an adapter's refusal, a folder's validity
    // would depend on whether that CLI happened to have a listing, so adding
    // one would silently start rejecting folders that used to succeed. (That
    // is not hypothetical — cursor gained a listing in milestone 4.)
    //
    // A null cwd is the graph builder asking what does NOT depend on a folder;
    // it is answered in geniro's own empty directory rather than refused.
    const projectDir =
      cwd === null ? this.folderlessDir() : resolveValidCwd(cwd);
    const plugin = pluginDir === null ? null : resolveValidPluginDir(pluginDir);
    const adapter = this.adapters.for(agent);
    // The adapter's own sentence, carried through untouched. A CLI that cannot
    // be listed is not asked at all — spawning it to receive a guaranteed
    // empty answer would health-check nothing and cost a process.
    const unavailableReason = adapter.getConfig().mcp.listingUnavailableReason;
    if (unavailableReason !== null) {
      return { servers: [], unavailableReason };
    }
    const version = await this.resolveVersionFn(agent, {
      // A Refresh means the user believes the machine changed, and the version
      // IS part of the cache key — reusing a memoized one would re-derive the
      // same key and hand back the very reading they asked to replace.
      forceRefresh: refresh,
      onSpawn: (child) =>
        this.processes.register(
          `mcp:version:${randomUUID()}`,
          childProcessHandle(child, { processGroup: false }),
        ),
    });
    const key = keyOf(agent, projectDir, plugin, version);
    if (refresh) {
      this.cache.delete(key);
    }
    // Single-flight is checked AFTER the refresh eviction on purpose: a
    // double-clicked Refresh should join the re-read already running, not
    // start a second one. Evicting the cache is idempotent; spawning is not.
    const pending = this.inFlight.get(key);
    if (pending) {
      return this.composeListing(adapter, agent, projectDir, await pending);
    }
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return this.composeListing(adapter, agent, projectDir, {
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
          { cwd: projectDir, pluginDir: plugin },
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
    return this.composeListing(adapter, agent, projectDir, await ask);
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
    // Its OWN field, not the listing's: a CLI that can be listed but not
    // switched (or the reverse) would otherwise be given a reason that answers
    // a different question.
    const toggleUnavailable = adapter.getConfig().mcp.toggleUnavailableReason;
    if (toggleUnavailable !== null) {
      throw new BadRequestException(
        'MCP_TOGGLE_UNSUPPORTED',
        `${agent} cannot be told which MCP servers to load: ${toggleUnavailable}`,
      );
    }
    const facts = await adapter.readMcpFolderFacts(projectDir);
    if (!facts.projectServers.includes(server)) {
      throw new BadRequestException(
        'MCP_SERVER_NOT_TOGGLEABLE',
        `${server} cannot be switched in ${projectDir} — ${adapter.getConfig().mcp.notInToggleableScopeReason}`,
      );
    }
    if (enabled && facts.userDisabled.includes(server)) {
      throw new BadRequestException(
        'MCP_SERVER_DISABLED_BY_USER',
        `${server} is ${adapter.getConfig().mcp.userDisabledReason}`,
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
  private async composeListing(
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
    const toggle = adapter.getConfig().mcp;
    return {
      servers: result.servers.map((server) => {
        // A CLI that cannot be switched at all reports `unknown`, not `other`:
        // "outside the disable-able scope" is a claim about the user's setup,
        // and this CLI has no such scope to be outside of.
        if (toggle.toggleUnavailableReason !== null) {
          return {
            ...server,
            scope: 'unknown' as const,
            // Not blanket-false: a CLI geniro cannot switch may still REPORT a
            // server as switched off in its own config (cursor's `mcp
            // disable`), and the wire flag asks whether the next turn will
            // leave the server out — whoever switched it off. Saying `false`
            // there would render an off server as on.
            disabled: server.status === 'disabled',
            toggleUnavailableReason: toggle.toggleUnavailableReason,
          };
        }
        const isProject = projectServers.has(server.name);
        const disabledByUser = userDisabled.has(server.name);
        return {
          ...server,
          scope: isProject ? ('project' as const) : ('other' as const),
          // The geniro half is gated on scope: the setting only suppresses
          // project servers, so a stale entry for a name that has since moved
          // to user scope would otherwise render struck-through and off while
          // every turn still loads it — the panel stating the opposite of what
          // the next turn does.
          disabled:
            server.status === 'disabled' ||
            disabledByUser ||
            (isProject && geniroDisabled.has(server.name)),
          toggleUnavailableReason: !isProject
            ? toggle.notInToggleableScopeReason
            : disabledByUser
              ? toggle.userDisabledReason
              : null,
        };
      }),
      unavailableReason: null,
    };
  }
}
