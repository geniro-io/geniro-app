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
  configValueWrite: 'config/value/write',
} as const;

/** The notification that completes the `initialize` handshake. */
export const CODEX_INITIALIZED_NOTIFICATION = 'initialized';

/** Server → client notifications this adapter reads. */
export const CODEX_NOTIFICATIONS = {
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

/** `codex mcp list`'s argv: the configured servers, as JSON. */
export const CODEX_MCP_LIST_ARGS = ['mcp', 'list', '--json'] as const;

/**
 * Where codex keeps its MCP servers in `config.toml`: one `mcp_servers.<name>`
 * table per server, whose `enabled` field is the switch.
 */
export const CODEX_MCP_SERVERS_KEY = 'mcp_servers';
export const CODEX_MCP_ENABLED_FIELD = 'enabled';

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
