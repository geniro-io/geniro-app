import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpOrigin,
  AgentMcpServer,
  AgentMcpServerHealth,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentMcpListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentSessionRegistry } from './agent-session.registry';
import { AgentVersionService } from './agent-version.service';
import { McpHarvestStore } from './mcp-harvest.store';
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
 * How long a listing request will wait for a cold dial before answering
 * `pending` and letting it finish in the background.
 *
 * Short enough that the panel always paints promptly, long enough that a folder
 * whose servers answer quickly is served in ONE round trip rather than two.
 * A dial that misses it is not merely slow — it is starting the user's own MCP
 * servers, which is seconds of work no request should be held open across.
 */
const FIRST_PAINT_BUDGET_MS = 400;

/**
 * The deadline a listing gets when a REQUEST is waiting on it — the toggle
 * route, which awaits the dial because the listing that results IS its answer.
 *
 * An adapter's own listing deadline is sized for the read nobody is holding a
 * socket open for: the panel's is answered inside {@link FIRST_PAINT_BUDGET_MS}
 * with `pending`, so a dial there may run as long as a cold dial genuinely
 * takes (claude's is two minutes). Awaiting that inside a request would put the
 * renderer's own 60s `MCP_ROUTE_TIMEOUT_MS` in front of it, and the user would
 * read a bare transport failure instead of the specific reason the daemon was
 * about to produce.
 *
 * So the cap is stated HERE rather than lowered in the adapter: how long an
 * HTTP round trip may take is a fact about this service's routes, and how long
 * a cold dial of the user's servers takes is a fact about the CLI. Collapsing
 * the two is what made a panel read inherit a budget that only the toggle
 * needed.
 *
 * In practice this deadline is almost never reached: a toggle can only be
 * clicked on a row the panel has already listed, so the cache is warm and the
 * blocking read returns from it without dialling anything.
 */
export const BLOCKING_LIST_TIMEOUT_MS = 45_000;

/**
 * Shown when the adapter itself misbehaved rather than the CLI refusing.
 *
 * The thrown error's own message is appended by {@link listingFailure}: this
 * arm only fires when an adapter broke its contract, which is precisely the
 * case where nobody can guess what happened from the sentence alone.
 */
const MCP_LIST_FAILED_REASON = 'could not read MCP servers';

/**
 * The directory a FOLDER-INDEPENDENT listing runs in, under userData.
 *
 * The graph builder has no folder: a workflow is edited long before it is run
 * in one. What it can honestly show is the set that does NOT depend on a
 * folder — the user's global servers plus whatever the node's own profile
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
 * - **configDir** — a profile carries its own MCP servers, so two nodes pointed
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
  configDir: string | null,
  version: string | null,
): string {
  return `${agent}\u0000${cwd}\u0000${configDir ?? ''}\u0000${version ?? ''}`;
}

/**
 * The prefix every key for one (agent, folder) shares, whatever profile or
 * binary version produced it.
 *
 * Here rather than spelled at its one call site, so the key SHAPE keeps one
 * home: a caller composing the first two fields itself is a second place that
 * has to be right when a dimension is added to {@link keyOf}.
 */
function keyPrefixOf(agent: AgentKind, cwd: string): string {
  return `${agent}\u0000${cwd}\u0000`;
}

/**
 * Fill a harvested row's unreported fields from a previous `mcp list` reading.
 *
 * A harvest knows a server's NAME and the state it was in; a listing knows how
 * the CLI reaches it (`target`, `transport`), which `system/init` does not
 * report at all. Neither is a superset, so serving one alone drops information
 * we hold — and `target` is what the panel's row tooltip shows.
 *
 * Deliberately one-directional: the harvest decides which servers exist and
 * what state they are in, and the listing only fills the blanks. A server the
 * old listing knew about but this turn did not load is genuinely gone (the user
 * switched it off, or removed it), so it must NOT be resurrected here.
 */
function enrich(
  harvested: AgentMcpServer[],
  listed: AgentMcpServer[] | undefined,
): AgentMcpServer[] {
  if (!listed?.length) {
    return harvested;
  }
  const byName = new Map(listed.map((server) => [server.name, server]));
  return harvested.map((server) => {
    const known = byName.get(server.name);
    if (!known) {
      return server;
    }
    return {
      ...server,
      target: server.target ?? known.target,
      transport: server.transport ?? known.transport,
      // Only while the two agree on the state. A `detail` explains a STATUS —
      // it is the reason a server failed — so pinning yesterday's failure
      // reason under today's `connected` row would state a problem that no
      // longer exists, and the panel renders exactly that string to the user.
      detail:
        server.detail ?? (server.status === known.status ? known.detail : null),
    };
  });
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
/**
 * Why a row carries no switch when the CLI's own config could not be read.
 *
 * NOT a per-CLI sentence, which is why it lives here rather than in an
 * adapter's config: it describes geniro's own read failing, not anything about
 * the CLI's capabilities.
 */
const MCP_STATE_UNREADABLE_REASON =
  'the state of this folder’s MCP servers could not be read, so switching one could not be verified';

@Injectable()
export class AgentMcpService {
  private readonly logger = new Logger(AgentMcpService.name);
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveVersionFn: AgentVersionService['resolve'];
  private readonly folderlessDirPath: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AgentMcpListingResult>>();
  /**
   * The verdict of a dial that finished after its caller had already been
   * answered `pending`, held until someone asks again.
   *
   * Only FAILURES land here — a success is remembered by {@link cache} like any
   * other. Without it a refusal reached nobody at all: the caller had gone, the
   * cache deliberately does not keep failures, and `inFlight` was cleared — so
   * the next ask started a whole fresh dial, LAUNCHING the user's MCP servers
   * again, and answered `pending` again. A polling panel never converged.
   *
   * Consumed exactly once, and below the cache, so it can neither shadow a
   * later good reading nor become the five-minute false claim the no-caching
   * rule exists to prevent.
   */
  private readonly deferredFailure = new Map<string, AgentMcpListingResult>();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    private readonly harvest: McpHarvestStore,
    private readonly sessions: AgentSessionRegistry,
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
    options: { configDir?: string | null; refresh?: boolean } = {},
  ): Promise<AgentMcpListingWire> {
    const { projectDir, adapter, result, pending } = await this.readServers(
      agent,
      cwd,
      options,
    );
    const listing = await this.composeListing(
      adapter,
      agent,
      projectDir,
      result,
    );
    return { ...listing, pending };
  }

  /**
   * The servers themselves — validation, the version key, the cache and the
   * single-flight — with none of the overlay {@link composeListing} adds.
   *
   * Split out so {@link setEnabled} can compose ONCE with folder facts it has
   * already read, rather than going through {@link list} and paying for a
   * second read of the same files on every toggle.
   *
   * `blocking` decides what a COLD read does. A panel gets `false` and is
   * answered at once with `pending: true` while the dial runs behind it; a
   * toggle gets `true`, because its whole answer is the listing that results
   * and there is nothing useful to hand back before it exists.
   */
  private async readServers(
    agent: AgentKind,
    cwd: string | null,
    options: {
      configDir?: string | null;
      refresh?: boolean;
      blocking?: boolean;
    } = {},
  ): Promise<{
    projectDir: string;
    adapter: AgentAdapter;
    result: AgentMcpListingResult;
    /** A dial is running; `result` is not the answer yet. */
    pending: boolean;
  }> {
    const { configDir = null, refresh = false, blocking = false } = options;
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
    const profile =
      configDir === null ? null : resolveValidConfigDir(configDir);
    const adapter = this.adapters.for(agent);
    // The adapter's own sentence, carried through untouched. A CLI that cannot
    // be listed is not asked at all — spawning it to receive a guaranteed
    // empty answer would health-check nothing and cost a process.
    const unavailableReason = adapter.getConfig().mcp.listingUnavailableReason;
    if (unavailableReason !== null) {
      return {
        projectDir,
        adapter,
        result: { ok: false, reason: unavailableReason },
        pending: false,
      };
    }
    const version = await this.resolveVersionFn(agent, {
      // A Refresh means the user believes the machine changed, and the version
      // IS part of the cache key — reusing a memoized one would re-derive the
      // same key and hand back the very reading they asked to replace.
      forceRefresh: refresh,
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `mcp:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    const key = keyOf(agent, projectDir, profile, version);
    const cached = this.cache.get(key);
    /**
     * The folder's servers as the last reading left them — what to PAINT while
     * a dial runs, never an answer in its own right (see {@link firstPaint}).
     *
     * Before this, a lapsed entry was worth nothing to the caller and the panel
     * opened on a bare spinner for as long as the dial took — 6s here against
     * nine servers, and up to the CLI's whole 45s deadline when one of them
     * hangs, which is the reported "MCP list has been loading for a minute".
     * The folder's servers now stay on screen the whole time. They carry the
     * previous reading's health rather than this moment's, which is exactly
     * what `pending` says — and the alternative was never fresher information,
     * only none.
     */
    const previous = cached?.servers ?? null;
    // Single-flight is checked BEFORE the cache on purpose: a double-clicked
    // Refresh should join the re-read already running, not start a second one.
    const running = this.inFlight.get(key);
    if (running) {
      return blocking
        ? { projectDir, adapter, result: await running, pending: false }
        : {
            projectDir,
            adapter,
            ...(await this.firstPaint(key, running, previous)),
          };
    }
    // A refresh SKIPS the cache rather than evicting it, and that distinction
    // is the whole of Reconnect's behaviour: the entry is what the panel keeps
    // showing while the re-dial runs, and every poll behind the refresh reads
    // it too. Evicting here blanked the list at the exact press that repairs a
    // broken server — measured against a real folder, where the refresh and
    // the six polls after it all came back with zero rows. The fresh reading
    // overwrites it below.
    if (!refresh && cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return {
        projectDir,
        adapter,
        result: { ok: true, servers: cached.servers },
        pending: false,
      };
    }
    // Below the cache, above the dial: the verdict of a dial whose caller had
    // already been answered `pending`. Delivering it here is what lets a
    // polling panel learn the read FAILED, instead of starting the whole cold
    // dial over and being told `pending` again.
    const deferred = this.deferredFailure.get(key);
    if (deferred && !refresh) {
      this.deferredFailure.delete(key);
      return { projectDir, adapter, result: deferred, pending: false };
    }
    this.deferredFailure.delete(key);
    // Nothing fresh to serve, and asking the CLI means a COLD DIAL of every
    // server. Before paying for that, take the answer a turn already gave us
    // for this exact (agent, folder, config dir) — `system/init` names the
    // servers the CLI loaded and the state each was in, at no cost, which is
    // why the CLI's own `/mcp` is instant while this route was not.
    //
    // Below the TTL branch on purpose: a verified reading is strictly better
    // than a harvested one (it carries each server's command line and a
    // settled status), so the harvest is the floor, never the ceiling.
    //
    // Skipped on `refresh`, which is the one thing that must always reach the
    // CLI. Init reports the state at TURN START and nothing later updates it,
    // so a server that was still connecting stays `pending` in the harvest for
    // as long as the harvest lives — and Reconnect is the only way it ever
    // settles. Serving the harvest here would make that button inert.
    const harvested = refresh
      ? null
      : this.harvest.get(agent, projectDir, profile);
    if (harvested !== null) {
      return {
        projectDir,
        adapter,
        // Merged with the LAPSED reading when there is one: the harvest has
        // the fresher status, the old listing has the `target`/`transport`
        // init never reports. Taking the union loses neither.
        result: { ok: true, servers: enrich(harvested, cached?.servers) },
        pending: false,
      };
    }
    // `Promise.resolve().then(…)` rather than a bare call: an adapter that
    // throws SYNCHRONOUSLY would otherwise walk straight past the `.catch`
    // below and reject the whole request, which this read must never do.
    const ask = Promise.resolve()
      .then(() =>
        adapter.listMcpServers(
          { cwd: projectDir, configDir: profile },
          {
            // Only a caller holding a request open gets a shortened deadline —
            // see {@link BLOCKING_LIST_TIMEOUT_MS}. The panel's read is answered
            // long before the dial finishes, so it keeps the adapter's own.
            ...(blocking ? { timeoutMs: BLOCKING_LIST_TIMEOUT_MS } : {}),
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
        return { ok: false, reason: this.listingFailure(err) };
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
    if (!blocking) {
      return {
        projectDir,
        adapter,
        ...(await this.firstPaint(key, ask, previous)),
      };
    }
    return { projectDir, adapter, result: await ask, pending: false };
  }

  /**
   * Give a running dial a short moment to finish, then answer without it.
   *
   * The cold read dials every server the folder defines — measured at 6.7s here
   * against nine, and bounded only by the slowest one, up to the CLI's whole
   * listing timeout. Awaiting that held the panel's HTTP request open for the
   * duration, so the user got a spinner and nothing else, and a cursor scope
   * got it EVERY time: the `mcp_servers` event has one producer (claude's
   * `system/init`), so no cursor folder ever has a harvest to answer from.
   *
   * A budget rather than an immediate `pending`, because most reads are not
   * actually slow — a folder with two quick stdio servers settles well inside
   * it, and answering `pending` there would cost the caller a second round trip
   * to learn what was already known. Past the budget the dial continues in
   * `inFlight` and the next ask collects it.
   *
   * The rejection is handled INSIDE `ask` (it resolves to a stated refusal
   * rather than throwing), so the un-awaited branch leaves nothing unobserved.
   */
  private async firstPaint(
    key: string,
    ask: Promise<AgentMcpListingResult>,
    /**
     * The folder's servers as the last reading left them, or null if this
     * folder has never been read. Painted while the dial runs — see the
     * `previous` capture in {@link readServers}.
     */
    stale: readonly AgentMcpServer[] | null,
  ): Promise<{
    result: AgentMcpListingResult;
    pending: boolean;
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FIRST_PAINT_BUDGET_MS);
      timer.unref?.();
    });
    const settled = await Promise.race([
      ask.then((result) => ({ result })),
      budget,
    ]);
    clearTimeout(timer);
    if (settled !== null) {
      return { result: settled.result, pending: false };
    }
    // Nobody is waiting on this dial any more, so its verdict would otherwise
    // reach no one — a success is kept by the cache, but a REFUSAL is
    // deliberately not cached, and the caller has gone. Held for the next ask
    // (see {@link deferredFailure}); without it the poll re-dials from cold,
    // launching the user's MCP servers again, and never converges.
    void ask.then((result) => {
      if (!result.ok) {
        this.deferredFailure.set(key, result);
      }
    });
    // The previous reading, or nothing on a folder never read. Either way
    // `pending` is true, so the panel keeps its spinner and the caller keeps
    // polling — the rows are what it draws MEANWHILE, never a settled answer.
    return {
      result: { ok: true, servers: stale === null ? [] : [...stale] },
      pending: true,
    };
  }

  /**
   * The refusal for a listing that THREW, keeping what the throw said.
   *
   * An adapter is not supposed to throw here, so this arm only fires when one
   * broke its contract — which is exactly the case where the flat sentence
   * alone leaves nobody able to tell a missing binary from a deadline from a
   * folder the CLI would not read. The panel is the only place this ever
   * surfaces, and it has room for the line.
   */
  private listingFailure(err: unknown): string {
    const detail = (err instanceof Error ? err.message : String(err)).trim();
    return detail
      ? `${MCP_LIST_FAILED_REASON} — ${detail}`
      : MCP_LIST_FAILED_REASON;
  }

  /**
   * Switch one server on or off for one agent in one folder.
   *
   * The MECHANISM belongs to the adapter — for claude, the CLI's own
   * `projects[<cwd>].disabledMcpServers`, so the switch is the same one the
   * user's terminal shows. This service only decides that the row may be
   * switched at all, and refuses anything it cannot actually change rather
   * than writing something with no effect: a silent no-op is the exact failure
   * the design forbids, because the user watches a switch move and the next
   * turn ignores it.
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
    if (enabled && facts.lockedOff.includes(server)) {
      throw new BadRequestException(
        'MCP_SERVER_DISABLED_BY_USER',
        `${server} is ${adapter.getConfig().mcp.userDisabledReason}`,
      );
    }
    try {
      await adapter.setMcpServerEnabled(projectDir, server, enabled, {
        // Registered like the listing's child, for the same reason: an adapter
        // whose mechanism is a subcommand rather than a file spawns a process,
        // and every child this daemon starts must be reapable on shutdown.
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `mcp:toggle:${randomUUID()}`,
            childProcessHandle(child, spawnInfo),
          ),
      });
    } catch (err) {
      // The adapter reaches the user's own config file and a real lock, so
      // this is where a contended write or an unparseable config surfaces.
      // Reported as a refusal with the reason, never swallowed: the panel is
      // about to re-render, and a toggle that failed must not read as one that
      // took.
      throw new BadRequestException(
        'MCP_TOGGLE_FAILED',
        `could not switch ${server} for ${agent}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The CLI reads its MCP configuration once, when it starts, and geniro
    // keeps that process alive across a chat's turns — so without this the
    // switch lands in the config and the agent goes on using the servers it
    // was spawned with. See `AgentSessionRegistry.markStale` for the report
    // this answers and for why the session is marked rather than closed.
    const retired = this.sessions.markStale(
      agent,
      projectDir,
      'its MCP servers changed',
    );
    if (retired > 0) {
      this.logger.log(
        `${retired} ${agent} session(s) in ${projectDir} will restart on their next turn — MCP servers changed`,
      );
    }
    // The cached READING is now about the previous configuration, and for a CLI
    // whose disabled state is only visible IN that reading it is the whole
    // answer: cursor reports a switched-off server as `disabled` in `mcp list`
    // and keeps no folder facts, so a cache hit here — and on every panel open
    // for the rest of the TTL — would put the switch straight back where the
    // user just moved it from. Patched rather than evicted, because evicting
    // charges the click a fresh cold dial of every server in the folder.
    //
    // Both directions are stated at the strength they are actually known.
    // Switching a server OFF makes the CLI report exactly `disabled` (measured).
    // Switching one ON says nothing about its health, so that direction is
    // ASKED rather than assumed: one server's dial, which both shipped CLIs have
    // a command for and which costs a fraction of the folder's. Only a CLI with
    // no such command (or a probe that could not be read) falls back to
    // `unknown`, which the panel draws as a listed server with its health
    // unstated — never a green dot nothing verified.
    const probed = enabled
      ? // `Promise.resolve().then(…)` rather than a bare call, the same guard
        // `readServers` puts in front of the listing: an adapter that throws
        // SYNCHRONOUSLY would otherwise walk straight past the `.catch` below,
        // and here that would fail the request over a write that already landed.
        await Promise.resolve()
          .then(() =>
            adapter.readMcpServerHealth(
              { cwd: projectDir, server },
              {
                onSpawn: (child, spawnInfo) =>
                  this.processes.register(
                    `mcp:health:${randomUUID()}`,
                    childProcessHandle(child, spawnInfo),
                  ),
              },
            ),
          )
          // An adapter must not throw here, but this runs AFTER a write that
          // already landed: failing the request now would report a toggle that
          // did take as one that did not, which is the one wrong answer this
          // route must never give.
          .catch((err: unknown) => {
            this.logger.warn(
              `probing ${server} for ${agent} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          })
      : null;
    this.patchCachedStatus(agent, projectDir, server, enabled, probed);
    // BLOCKING, unlike the panel's read: this route's entire answer is the
    // listing that resulted from the write, so handing back empty rows with
    // `pending` would leave the caller nothing to render the toggle against.
    const read = await this.readServers(agent, projectDir, { blocking: true });
    // Re-read rather than reusing `facts`: the write above changed exactly the
    // half `facts` reports, so the pre-write copy would render the state the
    // user just left.
    const listing = await this.composeListing(
      read.adapter,
      agent,
      read.projectDir,
      read.result,
    );
    return { ...listing, pending: false };
  }

  /**
   * Re-state one server's status in every cached reading of one (agent, folder).
   *
   * Called after a successful write, and it is what stops the switch springing
   * back. The disabled state of a cursor row is visible ONLY in the listing —
   * that CLI keeps no folder facts geniro can read cheaply — so a cache hit
   * composed from the pre-write reading reports the server the user just
   * switched off as on, both in this route's own answer and on every panel open
   * until the TTL lapses.
   *
   * The two directions are recorded at the strength they are known. OFF is
   * exact: `cursor-agent mcp list` reports a server switched off with its own
   * `mcp disable` as `disabled` (captured in `cursor-acp.const.ts`). ON is not —
   * the server's health is whatever a dial would find, and nothing has dialled
   * it — so it degrades to `unknown`, which the panel draws as a listed server
   * with its health unstated. Inventing `connected` there is the confident lie
   * this whole module is arranged to avoid.
   *
   * Every profile's entry for the folder is patched, not just the one that asked:
   * the toggle route takes no config directory and the CLI's state is per
   * (folder, server), so each profile's reading of it is now equally stale — the
   * same fact the renderer's own re-read of its other scopes is built on.
   */
  private patchCachedStatus(
    agent: AgentKind,
    cwd: string,
    server: string,
    enabled: boolean,
    /**
     * What a single-server dial just reported, when one was taken. Null means
     * nothing dialled it — a CLI without the command, or an answer that could
     * not be read — and the row degrades to `unknown` rather than to a guess.
     */
    probed: AgentMcpServerHealth | null,
  ): void {
    const prefix = keyPrefixOf(agent, cwd);
    const health: AgentMcpServerHealth = enabled
      ? (probed ?? { status: 'unknown', detail: null })
      : { status: 'disabled', detail: null };
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      let touched = false;
      const servers = entry.servers.map((row) => {
        if (row.name !== server) {
          return row;
        }
        touched = true;
        // `detail` travels WITH the status, never across one. A connection
        // failure's reason left under a `disabled` row states a problem that is
        // no longer being had, and the panel renders that string verbatim — so
        // the row takes the probe's own reason, or none.
        return { ...row, status: health.status, detail: health.detail };
      });
      if (touched) {
        this.cache.set(key, { ...entry, servers });
      }
    }
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
   *
   * The adapter's refusal becomes the sentence the panel shows, verbatim.
   */
  private async composeListing(
    adapter: AgentAdapter,
    agent: AgentKind,
    cwd: string,
    result: AgentMcpListingResult,
    // `pending` is the CALLER's fact — whether a dial is still running — not
    // anything this overlay can see, so each caller adds it.
  ): Promise<Omit<AgentMcpListingWire, 'pending'>> {
    // Read once, applied to BOTH exits: the note describes the CLI, not this
    // read, so a refused listing owes it just as much as a successful one —
    // arguably more, since a panel showing no rows at all is exactly where the
    // user starts wondering what happened to the servers they can see in their
    // terminal.
    const staticNote = adapter.getConfig().mcp.interactiveOnlyNote;
    if (!result.ok) {
      return {
        servers: [],
        unavailableReason: result.reason,
        // The STATIC one: this arm never reads the folder, so a note that can
        // only be composed from the machine has nothing behind it here.
        interactiveOnlyNote: staticNote,
      };
    }
    let factsUnavailable = false;
    const facts: AgentMcpFolderFacts = await adapter
      .readMcpFolderFacts(cwd)
      .catch((err: unknown): AgentMcpFolderFacts => {
        // Reading the CLI's own config is best-effort, but the failure is not
        // silent: every row renders read-only, which is the safe direction. A
        // switch offered over a state nobody could read would be showing a
        // position it never verified.
        this.logger.warn(
          `reading ${agent} MCP folder facts failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        factsUnavailable = true;
        return {
          disabled: [],
          lockedOff: [],
          origins: {},
          interactiveOnlyNote: null,
        };
      });
    const disabled = new Set(facts.disabled);
    const lockedOff = new Set(facts.lockedOff);
    // Where each row was DEFINED, and whether the folder's copy displaced a
    // user one. A name the adapter could not place is absent, which is what
    // `unknown` means — never a guess, since the label exists to explain a
    // surprise and a wrong one would manufacture another.
    const origin = (name: string): AgentMcpOrigin =>
      facts.origins[name] ?? { scope: 'unknown', shadowsUser: false };
    const toggle = adapter.getConfig().mcp;
    // Answered on EVERY row, including the two early arms below: sign-in is a
    // capability of the CLI, not of the toggle, and a CLI that cannot be
    // switched can still be signed in to. Threading it through each arm is what
    // stops the renderer inferring "signable" from a status — a stdio server
    // never needs auth, and a `needs_auth` row on a CLI without the command
    // would otherwise get a button that does nothing.
    const signInUnavailableReason =
      adapter.getConfig().mcp.loginUnavailableReason;
    // On every row for the reason above it, and NOT derived from the toggle
    // beside it: approving and switching are one subcommand on cursor and two
    // different things on claude, whose toggle works and whose approval is an
    // interactive screen.
    const approveUnavailableReason =
      adapter.getConfig().mcp.approveUnavailableReason;
    return {
      servers: result.servers.map((server) => {
        if (toggle.toggleUnavailableReason !== null) {
          return {
            ...server,
            signInUnavailableReason,
            approveUnavailableReason,
            ...origin(server.name),
            // Not blanket-false: a CLI geniro cannot switch may still REPORT a
            // server as switched off in its own config (cursor's `mcp
            // disable`), and the wire flag asks whether the next turn will
            // leave the server out — whoever switched it off. Saying `false`
            // there would render an off server as on.
            disabled: server.status === 'disabled',
            toggleUnavailableReason: toggle.toggleUnavailableReason,
          };
        }
        if (factsUnavailable) {
          return {
            ...server,
            signInUnavailableReason,
            approveUnavailableReason,
            ...origin(server.name),
            disabled: server.status === 'disabled',
            toggleUnavailableReason: MCP_STATE_UNREADABLE_REASON,
          };
        }
        const isLockedOff = lockedOff.has(server.name);
        return {
          ...server,
          signInUnavailableReason,
          approveUnavailableReason,
          // The scope is REPORTED, never used to decide anything: the toggle
          // writes the CLI's own per-folder list and reaches every scope, so
          // what still decides is whether the row is locked OFF, one line down.
          ...origin(server.name),
          // The listing cannot see the toggle — `claude mcp list` reports a
          // disabled server as though it were live (probe-verified) — so the
          // config's own list is what says whether the next turn loads it.
          disabled:
            server.status === 'disabled' ||
            isLockedOff ||
            disabled.has(server.name),
          toggleUnavailableReason: isLockedOff
            ? toggle.userDisabledReason
            : null,
        };
      }),
      unavailableReason: null,
      // The FOLDER's answer wins where it has one: cursor's own-app-only
      // servers are its installed plugins, a set no string in `getConfig()`
      // could name, so the adapter composes that sentence from the machine and
      // a CLI whose gap is fixed keeps its static one.
      interactiveOnlyNote: facts.interactiveOnlyNote ?? staticNote,
    };
  }
  /**
   * Forget every folder's listing, and say how many went — see
   * `CacheResetService`. {@link deferredFailure} goes with it: it is a held
   * REFUSAL, and serving it after a reset would answer the user's "start
   * over" with the failure they were trying to clear.
   */
  clearCache(): number {
    const dropped = this.cache.size + this.deferredFailure.size;
    this.cache.clear();
    this.deferredFailure.clear();
    return dropped;
  }
}
