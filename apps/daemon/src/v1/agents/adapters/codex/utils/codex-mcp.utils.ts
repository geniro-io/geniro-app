import { asArray, asRecord, asString } from '../../../utils/json-util';
import type {
  AgentMcpServer,
  AgentMcpServerDefinitions,
  AgentMcpServerStatus,
} from '../../adapter.types';
import {
  classifyMessage,
  encodeNotification,
  encodeRequest,
  type JsonRpcId,
} from '../../utils/json-rpc.utils';
import {
  CODEX_APPS_FEATURE_KEY,
  CODEX_APPS_SERVER_NAME,
  CODEX_BUILTIN_SIGN_IN_REASON,
  CODEX_BUILTIN_TOGGLE_REASON,
  CODEX_BUILTIN_TURN_TOGGLE_REASON,
  CODEX_INITIALIZED_NOTIFICATION,
  CODEX_MCP_ENABLED_FIELD,
  CODEX_MCP_SERVERS_KEY,
  CODEX_MCP_STARTUP_NOTIFICATION,
  CODEX_MCP_STATUS_DETAIL,
  CODEX_MCP_STATUS_MAX_PAGES,
  CODEX_MCP_STATUS_MAX_RELISTS,
  CODEX_MCP_STATUS_PAGE_SIZE,
  CODEX_METHODS,
  CODEX_PLUGIN_TOGGLE_REASON,
  CODEX_PLUGIN_TURN_TOGGLE_REASON,
  CODEX_PROJECT_TOGGLE_REASON,
  CODEX_UNSAFE_NAME_TURN_TOGGLE_REASON,
  CODEX_UNSAFE_SERVER_NAME,
  CODEX_USER_LAYER_TYPE,
} from '../codex.const';
import type {
  CodexMcpConfigEntry,
  CodexMcpLayer,
  CodexMcpServerStatus,
} from '../codex.types';
import { codexInitializeParams } from './codex-handshake.utils';

/**
 * The dotted config key for one MCP server's table — or, given a field, for
 * that field of it. A dotted key adds or edits one server without replacing
 * the whole `mcp_servers` table, so the user's own servers stay.
 */
export function codexMcpServerKey(server: string, field?: string): string {
  return [
    CODEX_MCP_SERVERS_KEY,
    server,
    ...(field === undefined ? [] : [field]),
  ].join('.');
}

// ── Reading codex's answers ─────────────────────────────────────────────────

/** One `McpServerStatus`, or null for an entry with no name. */
export function readCodexMcpServerStatus(
  value: unknown,
): CodexMcpServerStatus | null {
  const record = asRecord(value);
  const name = record ? asString(record.name) : null;
  if (record === null || !name) {
    return null;
  }
  const tools = asRecord(record.tools);
  return {
    name,
    runtimeStatus: asString(record.runtimeStatus),
    authStatus: asString(record.authStatus),
    pluginId: asString(record.pluginId),
    httpOrigin: asString(record.httpOrigin),
    toolCount: tools === null ? 0 : Object.keys(tools).length,
    toolsError: asString(record.toolsError),
  };
}

/** The layer a `ConfigLayerMetadata` names. */
function layerOf(metadata: unknown): CodexMcpLayer {
  const type = asString(asRecord(asRecord(metadata)?.name)?.type);
  return type === 'user' ? 'user' : type === 'project' ? 'project' : 'other';
}

/**
 * Every MCP server codex's EFFECTIVE config defines, by name — from a
 * `config/read` result: which layer defines it (read off `origins`, keyed by
 * dotted path), and its own `enabled` field.
 *
 * The layer of the server's `command`/`url` decides: that is where it is
 * DEFINED, while a lone `enabled` could sit in another layer. A server no key
 * of which carries an origin reads as `other`, which offers no switch — the
 * safe direction, since a switch writes codex's user `config.toml`.
 */
export function readCodexMcpConfig(
  result: unknown,
): Map<
  string,
  CodexMcpConfigEntry & { command: string | null; url: string | null }
> {
  const record = asRecord(result);
  const servers = asRecord(asRecord(record?.config)?.[CODEX_MCP_SERVERS_KEY]);
  const origins = asRecord(record?.origins) ?? {};
  const entries = new Map<
    string,
    CodexMcpConfigEntry & { command: string | null; url: string | null }
  >();
  if (servers === null) {
    return entries;
  }
  for (const [name, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (server === null) {
      continue;
    }
    const prefix = `${codexMcpServerKey(name)}.`;
    const defining =
      origins[`${prefix}command`] ??
      origins[`${prefix}url`] ??
      Object.entries(origins).find(([key]) => key.startsWith(prefix))?.[1];
    entries.set(name, {
      layer: defining === undefined ? 'other' : layerOf(defining),
      enabled: typeof server.enabled === 'boolean' ? server.enabled : null,
      command: asString(server.command),
      url: asString(server.url),
    });
  }
  return entries;
}

/**
 * A server's status, from what codex reported for an EPHEMERAL thread — the
 * set and the health the agent's own thread would get.
 *
 * `runtimeStatus` is codex's own word for the thread's connection and is read
 * first; without one (a listing that named no thread) the sign-in state and a
 * failed tool discovery are all there is. The config's own `enabled = false`
 * outranks both, since it is what decides whether the next turn loads it.
 */
export function codexMcpStatus(
  server: CodexMcpServerStatus,
  config: CodexMcpConfigEntry | null,
): { status: AgentMcpServerStatus; detail: string | null } {
  if (config?.enabled === false) {
    return { status: 'disabled', detail: null };
  }
  switch (server.runtimeStatus) {
    case 'connected':
      return { status: 'connected', detail: server.toolsError };
    case 'starting':
      return { status: 'loading', detail: null };
    case 'authenticationRequired':
      return { status: 'needs_auth', detail: null };
    case 'failed':
      return { status: 'failed', detail: server.toolsError };
    case 'cancelled':
      return { status: 'failed', detail: 'codex cancelled its startup' };
    case 'disabled':
      return { status: 'disabled', detail: null };
    case 'notStarted':
      return { status: 'unknown', detail: 'codex has not started it' };
    default:
      break;
  }
  // camelCase on the protocol, snake_case in the CLI — compared without them.
  if (server.authStatus?.replace(/_/g, '').toLowerCase() === 'notloggedin') {
    return { status: 'needs_auth', detail: null };
  }
  if (server.toolsError !== null) {
    return { status: 'failed', detail: server.toolsError };
  }
  return { status: 'unknown', detail: null };
}

/**
 * One listing row: the server as codex reported it, placed by codex's config.
 *
 * Whether a row can be SWITCHED is decided by where it is defined, because the
 * switch writes `mcp_servers.<name>.enabled` into codex's USER config: a server
 * defined there is switchable, while a plugin's server, a project's, or one
 * codex builds in (`codex_apps`) would gain a stray `[mcp_servers.<name>]`
 * table that defines nothing. Such rows say why instead.
 *
 * A server neither the config nor a plugin names is one `codex mcp login`
 * cannot find either (measured: `No MCP server named 'codex_apps' found`), so
 * that row says why it offers no sign-in. A transport's environment is never
 * read — it is where a server's secrets live.
 */
export function codexMcpRow(
  server: CodexMcpServerStatus,
  config:
    | (CodexMcpConfigEntry & { command: string | null; url: string | null })
    | null,
): AgentMcpServer {
  const { status, detail } = codexMcpStatus(server, config);
  const target = server.httpOrigin ?? config?.url ?? config?.command ?? null;
  const transport =
    server.httpOrigin !== null || config?.url
      ? 'http'
      : config?.command
        ? 'stdio'
        : null;
  return {
    name: server.name,
    target,
    transport,
    status,
    detail,
    toolCount:
      server.runtimeStatus === 'connected' && server.toolsError === null
        ? server.toolCount
        : null,
    plugin: server.pluginId,
    toggleUnavailableReason: toggleReason(server, config),
    turnToggleUnavailableReason: codexTurnToggleReason(
      server.name,
      server.pluginId,
      config,
    ),
    ...(config === null && server.pluginId === null
      ? { signInUnavailableReason: CODEX_BUILTIN_SIGN_IN_REASON }
      : {}),
  };
}

function toggleReason(
  server: CodexMcpServerStatus,
  config: CodexMcpConfigEntry | null,
): string | null {
  if (server.pluginId !== null) {
    return CODEX_PLUGIN_TOGGLE_REASON.replace('%s', server.pluginId);
  }
  if (config === null) {
    return CODEX_BUILTIN_TOGGLE_REASON;
  }
  switch (config.layer) {
    case 'user':
      return null;
    case 'project':
      return CODEX_PROJECT_TOGGLE_REASON;
    case 'other':
      return CODEX_BUILTIN_TOGGLE_REASON;
  }
}

// ── A workflow node's switched-off servers (one turn) ──────────────────────

/** A config entry codex can switch off with a thread override. */
function definesServer(
  entry:
    | (CodexMcpConfigEntry & { command: string | null; url: string | null })
    | null
    | undefined,
): boolean {
  // A table holding only `enabled` defines no transport, and an `enabled`
  // override layered on such a name fails the thread (see
  // `CODEX_APPS_SERVER_NAME`) — so only a real definition counts.
  return (
    entry !== null &&
    entry !== undefined &&
    (entry.command !== null || entry.url !== null)
  );
}

/**
 * Why a node cannot switch `server` off for its own turns, or null when it can
 * — the listing's per-row answer, the same decision `codexTurnMcpOverrides`
 * takes at run time.
 */
export function codexTurnToggleReason(
  server: string,
  pluginId: string | null,
  config:
    | (CodexMcpConfigEntry & { command: string | null; url: string | null })
    | null,
): string | null {
  if (definesServer(config)) {
    return CODEX_UNSAFE_SERVER_NAME.test(server)
      ? CODEX_UNSAFE_NAME_TURN_TOGGLE_REASON
      : null;
  }
  if (pluginId !== null) {
    return CODEX_PLUGIN_TURN_TOGGLE_REASON.replace('%s', pluginId);
  }
  return server === CODEX_APPS_SERVER_NAME
    ? null
    : CODEX_BUILTIN_TURN_TOGGLE_REASON;
}

/** The thread config that leaves a node's switched-off servers out. */
export interface CodexTurnMcpOverrides {
  /** Dotted config keys to merge into `thread/start` / `thread/resume`. */
  config: Record<string, unknown>;
  /** Names nothing here can switch off for one turn, in the order asked. */
  unreachable: string[];
}

/**
 * The thread config overrides that switch a workflow node's servers off for
 * its turns, read against codex's EFFECTIVE config for the folder (a
 * `config/read {cwd}` result).
 *
 * A server the config DEFINES (any layer) gets `mcp_servers.<name>.enabled =
 * false` — MEASURED on 0.161.0: an ephemeral thread started with
 * `{"mcp_servers.playwright.enabled": false}` listed `playwright` as
 * `disabled` with 0 tools in `mcpServerStatus/list`, every other server
 * unchanged. The built-in Apps server gets `features.apps = false` (see
 * {@link CODEX_APPS_SERVER_NAME}). Everything else — a plugin's server, a name
 * codex does not load, a name that is no single config key — is UNREACHABLE
 * and left alone: writing the `enabled` override for a name the config does
 * not define fails the WHOLE thread (`invalid transport`), so a guess here
 * would cost the turn rather than the switch.
 *
 * A project-layer definition takes the same key; that a thread override
 * outranks a project's `.codex/config.toml` follows codex's config layering
 * and was not measured separately.
 */
export function codexTurnMcpOverrides(
  configResult: unknown,
  servers: readonly string[],
): CodexTurnMcpOverrides {
  const defined = readCodexMcpConfig(configResult);
  const config: Record<string, unknown> = {};
  const unreachable: string[] = [];
  for (const server of new Set(servers)) {
    if (definesServer(defined.get(server))) {
      if (CODEX_UNSAFE_SERVER_NAME.test(server)) {
        unreachable.push(server);
      } else {
        config[codexMcpServerKey(server, CODEX_MCP_ENABLED_FIELD)] = false;
      }
    } else if (server === CODEX_APPS_SERVER_NAME) {
      config[CODEX_APPS_FEATURE_KEY] = false;
    } else {
      unreachable.push(server);
    }
  }
  return { config, unreachable };
}

// ── The listing dialogue ────────────────────────────────────────────────────

/** Request ids the dialogue uses; pages count up from {@link FIRST_PAGE_ID}. */
const INITIALIZE_ID = 1;
const CONFIG_READ_ID = 2;
const THREAD_START_ID = 3;
const FIRST_PAGE_ID = 4;

/** Where one listing has got to. */
export type CodexMcpListingOutcome =
  { ok: true; servers: AgentMcpServer[] } | { ok: false; reason: string };

/**
 * ONE ask of a fresh `codex app-server` for its MCP servers, as the
 * conversation it needs: the handshake, `config/read` for where each server is
 * defined, an EPHEMERAL `thread/start` in the folder — which loads exactly the
 * servers a turn there would and leaves nothing on disk (measured on 0.161.0:
 * no rollout, no row in codex's state database) — and then
 * `mcpServerStatus/list` for THAT thread, page by page.
 *
 * A thread is what makes the answer the agent's own. Asked with no thread,
 * codex reports every server with `runtimeStatus: null` — a plugin's server
 * that codex will never start looks exactly like one that works — while the
 * thread's answer says `disabled` for the first and `connected` for the second
 * (measured on the default profile: 8 servers, 4 connected, 4 disabled).
 *
 * A pure state machine over the child's accumulated stdout, so it is driven in
 * a spec with no process: `frames()` opens it, `converse(stdout)` answers each
 * reply, `settled(stdout)` ends the read, `outcome(stdout)` reads the result.
 * The ids are fixed and numbered; nothing else writes to this child.
 */
export class CodexMcpListing {
  /** How far into stdout complete lines have been read. */
  private consumed = 0;
  private configResult: unknown = undefined;
  private configAnswered = false;
  private threadId: string | null = null;
  private nextPageId = FIRST_PAGE_ID;
  private awaitingPage: number | null = null;
  private pages = 0;
  private statuses: CodexMcpServerStatus[] = [];
  private failure: string | null = null;
  private done = false;
  /**
   * The newest COMPLETE listing, kept while a re-ask waits on servers still
   * starting — what is served if the read ends before they finish.
   */
  private lastComplete: CodexMcpServerStatus[] | null = null;
  /** Each server's newest startup state, from codex's own notifications. */
  private readonly startup = new Map<string, string>();
  /** Servers a complete listing reported still starting, awaited by name. */
  private waitingFor: Set<string> | null = null;
  private relists = 0;
  /** Frames produced by a reply, waiting for `converse` to hand them out. */
  private outbox: string[] = [];

  constructor(
    private readonly clientVersion: string,
    private readonly cwd: string,
    /** One server only — the single-server health read. */
    private readonly serverName: string | null = null,
  ) {}

  /** The opening frames, written at the spawn. */
  frames(): string[] {
    return [
      encodeRequest(
        INITIALIZE_ID,
        CODEX_METHODS.initialize,
        codexInitializeParams(this.clientVersion),
      ),
      encodeNotification(CODEX_INITIALIZED_NOTIFICATION, {}),
      encodeRequest(CONFIG_READ_ID, CODEX_METHODS.configRead, {
        cwd: this.cwd,
      }),
      encodeRequest(THREAD_START_ID, CODEX_METHODS.threadStart, {
        cwd: this.cwd,
        ephemeral: true,
      }),
    ];
  }

  /** The frames the replies so far call for — each handed out once. */
  converse(stdout: string): string[] {
    this.consume(stdout);
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Every question has been answered, or one failed. */
  settled(stdout: string): boolean {
    this.consume(stdout);
    return this.failure !== null || (this.done && this.configAnswered);
  }

  /** The newest listing that finished, or the one now finished. */
  private finished(): CodexMcpServerStatus[] | null {
    return this.done ? this.statuses : this.lastComplete;
  }

  /** The rows, or why there are none. Null stdout is a read that never ended. */
  outcome(stdout: string | null): CodexMcpListingOutcome {
    if (stdout !== null) {
      this.consume(stdout);
    }
    if (this.failure !== null) {
      return { ok: false, reason: this.failure };
    }
    // A read that ended while a re-ask waited on a server still starting is
    // still a listing: the one that finished, with that server `loading`.
    const statuses = this.finished();
    if (statuses === null) {
      return {
        ok: false,
        reason:
          stdout === null
            ? 'codex did not answer about its MCP servers in time'
            : 'codex stopped before it finished listing its MCP servers',
      };
    }
    const config = readCodexMcpConfig(this.configResult);
    return {
      ok: true,
      servers: statuses.map((status) =>
        codexMcpRow(status, config.get(status.name) ?? null),
      ),
    };
  }

  private consume(stdout: string): void {
    const end = stdout.lastIndexOf('\n');
    if (end < this.consumed) {
      return;
    }
    const block = stdout.slice(this.consumed, end);
    this.consumed = end + 1;
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.onMessage(parsed);
    }
  }

  private onMessage(parsed: unknown): void {
    const message = classifyMessage(parsed);
    if (message.kind === 'notification') {
      this.onNotification(message.method, message.params);
      return;
    }
    if (message.kind !== 'response' && message.kind !== 'error') {
      return;
    }
    const failed = message.kind === 'error' ? message.message : null;
    const result = message.kind === 'response' ? message.result : undefined;
    switch (message.id) {
      case INITIALIZE_ID:
        if (failed !== null) {
          this.fail(`codex refused the handshake: ${failed}`);
        }
        return;
      case CONFIG_READ_ID:
        // Its absence costs the switches and the sign-in reasons, never the
        // listing: every row then reads as defined nowhere.
        this.configAnswered = true;
        this.configResult = failed === null ? result : undefined;
        return;
      case THREAD_START_ID: {
        if (failed !== null) {
          this.fail(`codex could not open a thread to list from: ${failed}`);
          return;
        }
        const threadId = asString(asRecord(asRecord(result)?.thread)?.id);
        if (threadId === null) {
          this.fail('codex opened a thread without naming it');
          return;
        }
        this.threadId = threadId;
        this.askPage(null);
        return;
      }
      default:
        this.onPage(message.id, failed, result);
    }
  }

  private onPage(id: JsonRpcId, failed: string | null, result: unknown): void {
    if (id !== this.awaitingPage) {
      return;
    }
    this.awaitingPage = null;
    if (failed !== null) {
      this.fail(`codex could not list its MCP servers: ${failed}`);
      return;
    }
    const record = asRecord(result);
    for (const entry of asArray(record?.data)) {
      const status = readCodexMcpServerStatus(entry);
      if (status !== null) {
        this.statuses.push(status);
      }
    }
    this.pages += 1;
    const cursor = asString(record?.nextCursor);
    if (cursor !== null && this.pages < CODEX_MCP_STATUS_MAX_PAGES) {
      this.askPage(cursor);
      return;
    }
    this.onListingComplete();
  }

  /**
   * A whole listing is in. A server still STARTING has no health yet — the
   * thread answers before its slower servers finish dialling (measured on
   * 0.161.0: `codex_apps` reported `starting` 130ms in) — so the listing is
   * asked again once codex announces each of them has finished starting, a
   * bounded number of times. codex bounds a server's startup itself and
   * announces a failure when it gives up, so the wait cannot outlive that.
   */
  private onListingComplete(): void {
    const starting = this.statuses
      .filter((status) => status.runtimeStatus === 'starting')
      .map((status) => status.name);
    if (starting.length === 0 || this.relists >= CODEX_MCP_STATUS_MAX_RELISTS) {
      this.done = true;
      return;
    }
    this.lastComplete = this.statuses;
    this.waitingFor = new Set(starting);
    this.relistWhenStarted();
  }

  /** `mcpServer/startupStatus/updated` for this listing's thread. */
  private onNotification(method: string, params: unknown): void {
    if (method !== CODEX_MCP_STARTUP_NOTIFICATION) {
      return;
    }
    const record = asRecord(params);
    const name = asString(record?.name);
    const status = asString(record?.status);
    const threadId = asString(record?.threadId);
    if (name === null || status === null) {
      return;
    }
    if (
      threadId !== null &&
      this.threadId !== null &&
      threadId !== this.threadId
    ) {
      return;
    }
    this.startup.set(name, status);
    this.relistWhenStarted();
  }

  /** Ask again once nothing awaited is still starting. */
  private relistWhenStarted(): void {
    if (this.waitingFor === null) {
      return;
    }
    for (const name of this.waitingFor) {
      const state = this.startup.get(name);
      if (state === undefined || state === 'starting') {
        return;
      }
    }
    this.waitingFor = null;
    this.relists += 1;
    this.statuses = [];
    this.pages = 0;
    this.askPage(null);
  }

  private askPage(cursor: string | null): void {
    const id = this.nextPageId;
    this.nextPageId += 1;
    this.awaitingPage = id;
    this.outbox.push(
      encodeRequest(id, CODEX_METHODS.mcpServerStatusList, {
        threadId: this.threadId,
        detail: CODEX_MCP_STATUS_DETAIL,
        limit: CODEX_MCP_STATUS_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
        ...(this.serverName === null ? {} : { serverName: this.serverName }),
      }),
    );
  }

  private fail(reason: string): void {
    if (this.failure === null) {
      this.failure = reason;
    }
  }
}

/**
 * Why `mcp_servers.<name>.enabled` must NOT be written for `server`, or null
 * when it may — read off a `config/read` result. The write lands in codex's
 * USER `config.toml`, so it is only meaningful for a server defined there: for
 * any other a `[mcp_servers.<name>]` table holding nothing but `enabled` would
 * be junk in the user's config, and the switch would move while codex went on
 * loading the server exactly as before.
 */
export function codexMcpToggleRefusal(
  configResult: unknown,
  server: string,
): string | null {
  const entry = readCodexMcpConfig(configResult).get(server);
  if (entry === undefined) {
    return `"${server}" is not defined in codex's config.toml, so the switch geniro writes there cannot reach it`;
  }
  switch (entry.layer) {
    case 'user':
      return null;
    case 'project':
      return `"${server}" is ${CODEX_PROJECT_TOGGLE_REASON}`;
    case 'other':
      return `"${server}" is ${CODEX_BUILTIN_TOGGLE_REASON}`;
  }
}

/** The profile's own server table, read off the USER layer of `config/read`. */
export type CodexUserMcpLayer =
  | {
      ok: true;
      servers: AgentMcpServerDefinitions;
      /** codex's own version of the file, the write's `expectedVersion`. */
      version: string | null;
      /** The `config.toml` the layer is, as codex names it. */
      file: string | null;
    }
  | { ok: false; reason: string };

/**
 * The `[mcp_servers]` table of the BASE user layer of a `config/read
 * {includeLayers: true}` result — see {@link CODEX_USER_LAYER_TYPE} for why
 * that layer and not the effective config. A table that is not an object, or
 * an entry that is not one, is refused rather than read around: the editor's
 * save replaces the whole table, so anything it could not show would be lost.
 */
export function readCodexUserMcpLayer(result: unknown): CodexUserMcpLayer {
  const layers = asArray(asRecord(result)?.layers);
  const layer = layers
    .map((entry) => asRecord(entry))
    .find((entry) => {
      const name = asRecord(entry?.name);
      return (
        asString(name?.type) === CODEX_USER_LAYER_TYPE &&
        (name?.profile === null || name?.profile === undefined)
      );
    });
  if (layer === undefined || layer === null) {
    return {
      ok: false,
      reason:
        'codex did not report its user config layer, so its MCP servers cannot be edited here',
    };
  }
  const file = asString(asRecord(layer.name)?.file);
  const config = asRecord(layer.config) ?? {};
  const raw = config[CODEX_MCP_SERVERS_KEY];
  const servers: AgentMcpServerDefinitions = {};
  if (raw !== undefined && raw !== null) {
    const table = asRecord(raw);
    if (table === null || Array.isArray(raw)) {
      return {
        ok: false,
        reason: `codex's ${CODEX_MCP_SERVERS_KEY} is not a table, so geniro will not rewrite it`,
      };
    }
    for (const [name, entry] of Object.entries(table)) {
      const record = asRecord(entry);
      if (record === null || Array.isArray(entry)) {
        return {
          ok: false,
          reason: `codex's ${CODEX_MCP_SERVERS_KEY}.${name} is not a table, so geniro will not rewrite it`,
        };
      }
      servers[name] = record;
    }
  }
  return { ok: true, servers, version: asString(layer.version), file };
}
