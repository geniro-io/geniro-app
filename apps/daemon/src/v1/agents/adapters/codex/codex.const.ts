import { GROUP_KILL_GRACE_MS } from '../../utils/kill-tree';

/**
 * The named facts about OpenAI's `codex` CLI — every one but a static fact the
 * adapter's `getConfig()` literal is the only reader of, which stays inline
 * beside the field it answers.
 *
 * Measured against codex-cli 0.157.1 (`@openai/codex`), driven over its own
 * `codex app-server` — stdio JSON-RPC, one JSON object per line. The CLI ships
 * no ACP server, so this is its first-party headless protocol; the TypeScript
 * bindings it generates (`codex app-server generate-ts`) are the wire contract
 * these names were read from.
 */

// ── Process ─────────────────────────────────────────────────────────────────

/** The argv that starts the protocol server — everything else rides stdin. */
export const CODEX_APP_SERVER_ARGS = ['app-server'] as const;

/**
 * The config-override flag the CLI takes at spawn (`-c key=value`, a dotted
 * path with a TOML value).
 */
export const CODEX_CONFIG_FLAG = '-c';
export const CODEX_TITLE_MODEL_FLAG = '-m';

export const CODEX_OLLAMA_PROVIDER = 'geniro-ollama';

/** What this client calls itself in `initialize.clientInfo`. */
export const CODEX_CLIENT_NAME = 'geniro';

/** The directory codex keeps its login, config and conversations in. */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/** That directory when no profile names another — codex's own default. */
export const CODEX_DEFAULT_HOME_DIR_NAME = '.codex';

// ── Context window ──────────────────────────────────────────────────────────

/**
 * The config key that sets a thread's context window, passed at spawn as
 * `-c model_context_window=<tokens>`. MEASURED on 0.161.0 against
 * `gpt-6.1-sol` over app-server: no override reported `modelContextWindow`
 * 258,400, `=872000` reported 828,400 — codex clamps the value to the model's
 * `max_context_window` and keeps `effective_context_window_percent` (95) of it.
 * Above 272k input tokens the API bills the WHOLE request at 2× input and
 * 1.5× output, which is why the default stays codex's own.
 */
export const CODEX_CONTEXT_WINDOW_KEY = 'model_context_window';

/**
 * codex's own model catalog, which it refreshes into its home — the ONLY place
 * a model's default and maximum windows are written down: `model/list`
 * carries neither (0.161.0). An internal file, read defensively: a shape that
 * moves costs the picker, never the turn.
 */
export const CODEX_MODELS_CACHE_FILE = 'models_cache.json';

/**
 * The credentials codex authenticates with from the environment, read out of
 * the binary's own string table — withheld from every OTHER agent's child and
 * handed back to codex's alone when the user exported one.
 */
export const CODEX_CREDENTIAL_ENV_KEYS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const;

/**
 * Names that are not codex's login but still identify its account or state —
 * a GitHub token its cloud tasks use, its config home and its state database.
 * Stripped from every child like the credentials; never re-injected, since a
 * run's own config directory is what decides which account it is.
 */
export const CODEX_ACCOUNT_ENV_KEYS = [
  'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
  CODEX_HOME_ENV,
  'CODEX_SQLITE_HOME',
] as const;

// ── Protocol ────────────────────────────────────────────────────────────────

/** Client → server requests this adapter sends. */
export const CODEX_METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  threadRead: 'thread/read',
  threadDelete: 'thread/delete',
  threadCompact: 'thread/compact/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list',
  skillsList: 'skills/list',
  rateLimitsRead: 'account/rateLimits/read',
  configRead: 'config/read',
  configValueWrite: 'config/value/write',
  configBatchWrite: 'config/batchWrite',
  mcpServerStatusList: 'mcpServerStatus/list',
} as const;

/** The notification that completes the `initialize` handshake. */
export const CODEX_INITIALIZED_NOTIFICATION = 'initialized';

/** Server → client notifications this adapter reads. */
export const CODEX_NOTIFICATIONS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  planUpdated: 'turn/plan/updated',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  error: 'error',
  modelRerouted: 'model/rerouted',
} as const;

/** Server → client requests: the verdicts and answers codex waits on. */
export const CODEX_SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
} as const;

/**
 * The `_meta.codex_approval_kind` that marks an elicitation as codex asking to
 * run ONE MCP tool call — an approval with the tool's arguments in
 * `_meta.tool_params`, not a form the server wants filled (measured on 0.157.1:
 * every MCP call outside `never` approval arrives this way).
 */
export const CODEX_MCP_TOOL_APPROVAL_KIND = 'mcp_tool_call';

/**
 * codex's own question tool — what a card for `item/tool/requestUserInput` is
 * named. Also `AdapterConfig.questionToolName`.
 */
export const CODEX_QUESTION_TOOL_NAME = 'request_user_input';

/** Tool names geniro gives codex's item types, for the transcript's rows. */
export const CODEX_TOOL_NAMES = {
  command: 'shell',
  /** Input written to a command already running, rather than a new command. */
  writeStdin: 'write_stdin',
  fileChange: 'apply_patch',
  webSearch: 'web_search',
  imageView: 'view_image',
  permissions: 'request_permissions',
  subagent: 'spawn_agent',
} as const;

/**
 * The prompt a `/compact` turn carries — codex's own slash command, which this
 * adapter answers with `thread/compact/start` instead of sending it as text.
 * Also the `prompt` of the `compact` entry in `AdapterConfig.geniroCommands`.
 */
export const CODEX_COMPACT_PROMPT = '/compact';

/**
 * The config key codex compacts its own context at — a token count, with no
 * summary buffer of its own on top (unlike claude's window flag).
 */
export const CODEX_AUTO_COMPACT_KEY = 'model_auto_compact_token_limit';

/** Reasoning-summary detail every turn asks for, so thinking streams. */
export const CODEX_REASONING_SUMMARY = 'auto';

/** The longest a delegate's label (its brief's first line) is drawn. */
export const CODEX_DELEGATE_LABEL_MAX_CHARS = 80;

/** The longest a refused follow-up is quoted back in the notice that says so. */
export const CODEX_STEER_PREVIEW_MAX_CHARS = 60;

/**
 * The words codex refuses a `thread/resume` with while ANOTHER codex process
 * holds the thread — it allows one writer per thread. Measured on 0.157.1:
 * `thread <id> already has an active writer`, as JSON-RPC -32600, the code
 * every invalid request shares, so these words are the only thing telling it
 * apart from a thread that is gone (codex's own TUI matches them too, in
 * `tui/src/app_server_session.rs`). The holder is typically the user's own
 * `codex resume` in a terminal; the thread is released only when that process
 * ends — `thread/unsubscribe` answers `unsubscribed` and releases nothing.
 */
export const CODEX_ACTIVE_WRITER_MARKER = 'already has an active writer';

/**
 * How far apart, and how often, a resume refused for an active writer is asked
 * again before the turn fails over it. Sized to outlast a holder geniro itself
 * just closed: the session registry signals the old process and spawns its
 * replacement at once, and a process group still alive `GROUP_KILL_GRACE_MS`
 * after SIGTERM is SIGKILLed — so one retry past that grace, nothing geniro
 * started can still hold the thread, and whatever does is the user's own.
 */
export const CODEX_ACTIVE_WRITER_RETRY_MS = 500;
export const CODEX_ACTIVE_WRITER_RETRIES =
  Math.ceil(GROUP_KILL_GRACE_MS / CODEX_ACTIVE_WRITER_RETRY_MS) + 1;

/**
 * How long codex waits on one call to geniro's OWN MCP server: a day. Its
 * tools include ones that wait on a person (`ask_user_question`) or on a whole
 * callee turn (`call_agent`), far past codex's per-server default. Set on
 * geniro's entry alone, so the user's own servers keep their own timeouts.
 */
export const CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC = 24 * 60 * 60;

/**
 * How long a one-shot listing (`thread/list`, `model/list`, …) may take, from
 * spawn to its reply. Measured at 130-700ms warm; the ceiling is for a cold
 * start on a busy machine.
 */
export const CODEX_ONESHOT_TIMEOUT_MS = 20_000;

/** How long the running process has to answer a plan-limits question. */
export const CODEX_PLAN_LIMITS_TIMEOUT_MS = 10_000;

/** How long a model listing is served before codex is asked again. */
export const CODEX_MODELS_TTL_MS = 10 * 60_000;

/**
 * How many conversations a SEARCH reads before filtering: a query is matched
 * here rather than by codex, so the page it filters has to be wider than the
 * rows it returns.
 */
export const CODEX_SESSION_SEARCH_PAGE = 500;

/** MCP server names that cannot be written as one dotted config key. */
export const CODEX_UNSAFE_SERVER_NAME = /[.\s"'[\]]/;

/**
 * Where codex keeps its MCP servers in `config.toml`: one `mcp_servers.<name>`
 * table per server, whose `enabled` field is the switch.
 */
export const CODEX_MCP_SERVERS_KEY = 'mcp_servers';
export const CODEX_MCP_ENABLED_FIELD = 'enabled';

// ── Editing the MCP servers ─────────────────────────────────────────────────

/**
 * The profile's OWN servers are the `[mcp_servers]` table of the USER layer of
 * `config/read {includeLayers: true}` — the raw TOML as JSON, not the
 * effective config, which fills in `environment_id`, `enabled` and
 * `tool_timeout_sec` defaults the user never wrote. The layer whose
 * `name.type` is `user` and whose `profile` is null is the base
 * `<CODEX_HOME>/config.toml` (a profile-v2 layer names its profile); its
 * `version` (`sha256:…` of the file) is the token `config/batchWrite` checks
 * as `expectedVersion`. A missing file still answers a user layer, with an
 * empty config. PROBED on 0.161.0 against a throwaway CODEX_HOME.
 */
export const CODEX_USER_LAYER_TYPE = 'user';

/**
 * A whole-table write: `config/batchWrite {edits: [{keyPath: "mcp_servers",
 * value: {...}, mergeStrategy: "replace"}], expectedVersion}`. PROBED on
 * 0.161.0 against a throwaway CODEX_HOME holding a comment, a model line, two
 * servers and a `[profiles.x]` table: the replace dropped the server left out,
 * rewrote the one changed, added the new one (an `http_headers` subtable
 * included), and kept the comment, the model and the profile byte for byte.
 * A stale `expectedVersion` is refused (`configVersionConflict`, "Configuration
 * was modified since last read"), and an entry with neither `command` nor
 * `url` is refused too (`configValidationError`, "invalid transport in
 * `mcp_servers.bad`") — codex validates its own format, so geniro need not
 * re-implement it.
 */
export const CODEX_MCP_REPLACE_STRATEGY = 'replace';
export const CODEX_MCP_UPSERT_STRATEGY = 'upsert';

/**
 * `codex mcp add <name> [--env K=V]… -- <command> [args…]`, for a STDIO server.
 * PROBED on 0.161.0 against a throwaway CODEX_HOME: it writes
 * `[mcp_servers.<name>]` with `command`/`args`, and `codex mcp list` lists it.
 * Two behaviours shape how it is used. It OVERWRITES an existing name without
 * a word (`Added global MCP server` both times), so the adapter refuses a name
 * in use before running it. And an HTTP server is NOT added through it:
 * `codex mcp add --url` probes the server for OAuth and, finding it, starts
 * the login flow at once (`Detected OAuth support. Starting OAuth flow` in the
 * 0.161.0 binary) — a browser opened by a background daemon with nobody
 * watching, and a command that waits on its callback. An HTTP server is
 * written with `config/batchWrite` instead, and signed in to afterwards with
 * the row's ordinary Sign in (`codex mcp login <name>`). Its `--url` form has
 * no header flag either, which the write covers (`http_headers`).
 */
export const CODEX_MCP_ADD_ARGS: readonly string[] = ['mcp', 'add'];
export const CODEX_MCP_ADD_ENV_FLAG = '--env';
/** Writes one table and dials nothing for a stdio server. */
export const CODEX_MCP_ADD_TIMEOUT_MS = 20_000;
/** The field codex reads an HTTP server's headers from. */
export const CODEX_MCP_HTTP_HEADERS_FIELD = 'http_headers';

// ── MCP listing ─────────────────────────────────────────────────────────────

/**
 * How much of each server `mcpServerStatus/list` reports: its tools and its
 * sign-in state, without resources. MEASURED on 0.161.0: `full` answered
 * ~945KB for ONE server (codex_apps, 101 tools) on one profile; this answered
 * ~580KB for eight servers on another.
 */
export const CODEX_MCP_STATUS_DETAIL = 'toolsAndAuthOnly';

/**
 * The page size asked for. codex picks one when none is given (it answered all
 * eight servers in one page on 0.161.0), so this only bounds a pathological
 * profile; further pages are followed up to {@link CODEX_MCP_STATUS_MAX_PAGES}.
 */
export const CODEX_MCP_STATUS_PAGE_SIZE = 100;
export const CODEX_MCP_STATUS_MAX_PAGES = 10;

/**
 * The notification codex sends as each of a thread's MCP servers moves
 * through its startup (`starting` → `ready` | `failed` | `cancelled`) — what
 * the listing waits on before asking again about a server still starting.
 */
export const CODEX_MCP_STARTUP_NOTIFICATION = 'mcpServer/startupStatus/updated';

/** How many times a listing is asked again while servers are still starting. */
export const CODEX_MCP_STATUS_MAX_RELISTS = 3;

/**
 * How long the listing may take, from spawn to its last page. It opens an
 * EPHEMERAL thread and so starts every server the agent would — measured at
 * ~1.6s for eight servers on 0.161.0 — and a slow stdio server is bounded by
 * codex's own startup timeout, so this is generous rather than tight.
 */
export const CODEX_MCP_LIST_TIMEOUT_MS = 60_000;

/**
 * How much reply the listing may read. The status reply carries every tool's
 * description and schema, which is most of its size (see
 * {@link CODEX_MCP_STATUS_DETAIL}) — the base's 1M default would cut a large
 * account's listing off and report it as a CLI that could not answer.
 */
export const CODEX_MCP_LIST_MAX_OUTPUT_CHARS = 32 * 1024 * 1024;

/** How long a running process has to answer the context readout's question. */
export const CODEX_CONTEXT_READ_TIMEOUT_MS = 10_000;

/**
 * Why a server outside codex's config has no switch here. The case it was
 * written for is `codex_apps`, the server codex builds in for ChatGPT Apps
 * (connectors): it is in no config file, codex loads it for a ChatGPT account
 * and authenticates it with that account's own token (`authStatus:
 * bearerToken`), and `codex mcp login codex_apps` answers `No MCP server named
 * 'codex_apps' found` (measured on 0.161.0). Rows are classified by where
 * codex's config says a server comes from, never by that name.
 */
export const CODEX_BUILTIN_TOGGLE_REASON =
  'built into codex rather than defined in its config.toml — the switch geniro writes (`mcp_servers.<name>.enabled`) cannot reach it';

/** Why a plugin's server has no switch here; `%s` is the plugin. */
export const CODEX_PLUGIN_TOGGLE_REASON =
  'comes with the codex plugin %s, not from config.toml — codex has no per-server switch for it here; turn the plugin off in codex itself';

/** Why a server defined in a project's own `.codex/config.toml` has no switch here. */
export const CODEX_PROJECT_TOGGLE_REASON =
  "defined in this project's .codex/config.toml — geniro switches servers only in codex's own config.toml";

// ── A workflow node's switched-off servers (one turn) ──────────────────────

/**
 * The server codex builds in for ChatGPT Apps (connectors), and the feature
 * flag that is its switch. It is defined in no config file, so the thread
 * override that switches a config server off (`mcp_servers.<name>.enabled`)
 * cannot reach it — MEASURED on 0.161.0 it does worse than nothing: an
 * `enabled = false` override for a name the config does not define FAILS the
 * whole `thread/start` (`-32600 failed to load configuration: invalid
 * transport in mcp_servers.codex_apps`). `features.apps = false` in the same
 * thread config removed `codex_apps` (183 tools) from `mcpServerStatus/list`
 * and nothing else.
 */
export const CODEX_APPS_SERVER_NAME = 'codex_apps';
export const CODEX_APPS_FEATURE_KEY = 'features.apps';

/**
 * Why a node cannot switch off a plugin's server for its own turns. MEASURED
 * on 0.161.0: `plugins.<id>.enabled = false` in the thread config does remove
 * the plugin's server (`cua_repl` of `unified-computer-use@openai-bundled`) —
 * by turning the WHOLE plugin off, everything else it ships with it, so it is
 * a plugin switch rather than a server one. `%s` is the plugin.
 */
export const CODEX_PLUGIN_TURN_TOGGLE_REASON =
  'comes with the codex plugin %s — codex can leave it out of a turn only by turning the whole plugin off, so it is not switched here';

/** Why a node cannot switch off a server codex builds in, other than Apps. */
export const CODEX_BUILTIN_TURN_TOGGLE_REASON =
  'built into codex rather than defined in its config.toml, and codex has no per-turn switch for it';

/** Why a node cannot switch off a server whose name is no single config key. */
export const CODEX_UNSAFE_NAME_TURN_TOGGLE_REASON =
  'its name cannot be written as one codex config key, so a turn cannot switch it off';

/** Why a server outside codex's config cannot be signed in to from here. */
export const CODEX_BUILTIN_SIGN_IN_REASON =
  'signs in with the account codex itself is signed in to — `codex mcp login` does not know it by name';

/**
 * What `codex mcp login` prints when it did NOT sign in, read out of 0.161.0:
 * a server it cannot find, a server that is not an OAuth one, and the `Error: `
 * prefix every refusal of the CLI starts with. A successful run prints the
 * authorization URL and `Successfully logged in to MCP server '<name>'`, and
 * never `Error:`.
 */
export const CODEX_MCP_LOGIN_FAILURE_MARKERS = [
  'No MCP server named',
  'OAuth login is only supported',
  'Error:',
] as const;

/**
 * The throwaway turn that names a chat: `codex exec` prints only the final
 * message on stdout (measured on 0.157.1), keeps no session (`--ephemeral`),
 * may touch nothing (`read-only`), and thinks as little as it can. It skips the
 * profile's `config.toml` (auth still comes from `CODEX_HOME`), so the quoted
 * transcript meets no MCP server in a turn nobody is watching.
 */
export const CODEX_TITLE_ARGS = [
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '-s',
  'read-only',
  CODEX_CONFIG_FLAG,
  'model_reasoning_effort="low"',
] as const;

/** How long the naming turn may take. */
export const CODEX_TITLE_TIMEOUT_MS = 60_000;

/**
 * A codex thread id: a UUID (v7 today). What `codex resume <id>` accepts, and
 * what a stored session id must look like before one is built.
 */
export const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many threads' facts the adapter keeps for the context readout. A fact is
 * a few hundred bytes and only a live process can be asked about, so this
 * bounds a long-running daemon rather than any real working set.
 */
export const CODEX_THREAD_FACTS_MAX = 256;
