import type {
  AdapterConfig,
  AgentApprovalMode,
  AgentModel,
} from '../adapter.types';

/**
 * Every constant the `cursor-agent` adapter needs, in one place.
 *
 * Nothing about this CLI is spelled as a literal inside `cursor.adapter.ts` or
 * any `cursor/utils/**` helper — argv flags, env var names, parse patterns and
 * user-facing message templates are all named here, grouped by what they are
 * about. The static subset the base class reads is assembled from them by
 * `CursorAdapter.getConfig()`, whose `null` / `[]` members are the DECLARED
 * facts about what this CLI cannot do, not omissions.
 */

// ── Turn argv ─────────────────────────────────────────────────────────────

/**
 * The invariant head of every turn's argv: `-p` headless, stream-json out, and
 * `--force` — this CLI's whole permission model (there is no per-turn channel
 * to hold a tool call on).
 */
export const CURSOR_BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--force',
];

/**
 * Trust the turn's cwd without prompting (headless-only). Only ever set for a
 * daemon-created directory the user never opened.
 */
export const CURSOR_TRUST_FLAG = '--trust';

export const CURSOR_MODEL_FLAG = '--model';
export const CURSOR_RESUME_FLAG = '--resume';

/** `cursor-agent models` (== `--list-models`) — the live model list. */
export const CURSOR_MODELS_SUBCOMMAND: readonly string[] = ['models'];

// ── Child env ─────────────────────────────────────────────────────────────

/**
 * The daemon receives the Keychain-sourced Cursor key under this GENIRO_-prefixed
 * name, which `spawn-cli` strips from EVERY child env...
 */
export const CURSOR_API_KEY_SOURCE_ENV = 'GENIRO_CURSOR_API_KEY';

/** ...and only this child gets it back, so the claude agent never sees it. */
export const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

// ── Stream-json session id ────────────────────────────────────────────────

/**
 * Field names `cursor-agent` may use for the resumable chat/session id, across
 * versions. The spec flags Cursor schema drift as HIGH, and `--resume [chatId]`
 * exists but the emitting field is not contract-stable — so we read whichever
 * is present and degrade to a fresh session if none is.
 */
export const CURSOR_SESSION_ID_KEYS = [
  'session_id',
  'sessionId',
  'chatId',
  'chat_id',
  'threadId',
  'thread_id',
] as const;

// ── Approval policy ───────────────────────────────────────────────────────

/**
 * `auto` is the only honest entry: `--force` plus the static allow/deny list
 * in `~/.cursor/cli-config.json` IS this CLI's permission model, and there is
 * no per-turn channel to hold a tool call on. Offering `ask` would be a
 * control that changes nothing.
 */
export const CURSOR_APPROVAL_MODES = [
  'auto',
] as const satisfies readonly AgentApprovalMode[];

/** Nothing to probe — the one mode it has needs no binary to confirm it. */
export const CURSOR_PROBED_APPROVAL_MODES =
  [] as const satisfies readonly AgentApprovalMode[];

/**
 * Everything becomes `auto`, and anything else asked for is REPORTED rather
 * than quietly ignored: a workflow node may still be authored with `ask` (the
 * graph schema is CLI-agnostic), and a silent degrade there would read as
 * enforced permissions that never existed.
 */
export const cursorApprovalDegradeReason = (
  requested: AgentApprovalMode,
): string =>
  `cursor-agent has no approval callback — approval '${requested}' degrades to auto-approve for this turn`;

// ── Models ────────────────────────────────────────────────────────────────

/**
 * The set offered when the CLI cannot be asked — an install too old to have
 * the `models` subcommand, or one that is not signed in. These are the ids
 * cursor-agent's own `--model` help gives as examples, so they are the only
 * ones documented to work without asking the account.
 */
export const CURSOR_BUILTIN_MODELS: AgentModel[] = [
  { id: 'gpt-5', label: 'gpt-5', source: 'builtin' },
  { id: 'sonnet-4', label: 'sonnet-4', source: 'builtin' },
  { id: 'sonnet-4-thinking', label: 'sonnet-4-thinking', source: 'builtin' },
];

/** The unauthenticated notice the CLI prints instead of a list. */
export const CURSOR_NO_MODELS_PATTERN = /no models available/i;

/** A heading line, not a model id. */
export const CURSOR_MODELS_HEADING_PATTERN = /^(available )?models:?$/i;

/**
 * The id at the head of a line, stopping before the "(current)"/"(default)"
 * tags cursor appends — those are per-session state, not part of the id.
 */
export const CURSOR_MODEL_ID_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._/:@-]*)/;

// ── Skills / commands on disk ─────────────────────────────────────────────

/** `<root>/.cursor/commands/**.md`. */
export const CURSOR_COMMANDS_SEGMENTS: readonly string[] = [
  '.cursor',
  'commands',
];

// ── The `.cursor/mcp.json` merge lifecycle ────────────────────────────────

/**
 * Where cursor-agent reads project MCP servers from, as path segments under
 * the turn's cwd. The ONE spelling — the merge service, the file mechanics and
 * the git-tracked check all join it, so the path this CLI reads and the path
 * geniro writes cannot drift apart.
 */
export const CURSOR_MCP_CONFIG_SEGMENTS: readonly string[] = [
  '.cursor',
  'mcp.json',
];

/** `cursor-agent mcp enable <key>` — the argv head; the key is geniro's own. */
export const CURSOR_MCP_ENABLE_SUBCOMMAND: readonly string[] = [
  'mcp',
  'enable',
];

/** `cursor-agent mcp enable` must never wedge a turn start — bound it. */
export const CURSOR_MCP_ENABLE_TIMEOUT_MS = 10_000;

/**
 * Lock wait before a caller turn degrades. Long enough for a quick prior turn
 * to clear the cwd, short enough that a caller-chain deadlock (a lock-holding
 * cursor caller synchronously awaiting a callee that needs the same cwd's
 * lock) breaks into a visible degrade instead of hanging the run.
 */
export const CURSOR_MCP_LOCK_WAIT_MS = 30_000;

/** The crash journal, under the daemon's userData dir. */
export const CURSOR_MCP_JOURNAL_FILE = 'cursor-mcp-journal.json';

export const CURSOR_MCP_GIT_COMMAND = 'git';

export const CURSOR_MCP_GIT_CHECK_TIMEOUT_MS = 5_000;

/**
 * Ask git whether the token-bearing config file is TRACKED in `cwd`'s repo —
 * `--error-unmatch` turns "not tracked" into a non-zero exit, so the answer is
 * the exit code rather than parsed output.
 */
export const cursorMcpGitTrackedArgs = (cwd: string): string[] => [
  '-C',
  cwd,
  'ls-files',
  '--error-unmatch',
  CURSOR_MCP_CONFIG_SEGMENTS.join('/'),
];

// ── The MCP-trust probe ───────────────────────────────────────────────────

/** The probe's synthetic node id on the `/v1/mcp/<probeId>/<nodeId>` route. */
export const CURSOR_PROBE_NODE_ID = 'probe';

/** Probe run ids are self-describing so a transcript row can never carry one. */
export const CURSOR_PROBE_RUN_PREFIX = 'probe-';

/** The one tool the probe's MCP host serves — and the whole of its autoApprove. */
export const CURSOR_PROBE_ECHO_TOOL = 'echo';

export const CURSOR_PROBE_PROMPT =
  'An MCP server named "geniro" provides one tool called "echo". Call the ' +
  'echo tool exactly once with the text "geniro-probe" and then reply with ' +
  'its result. If no such tool is available, reply exactly: no tool.';

/** A hung probe turn must not wedge run-start forever. */
export const CURSOR_PROBE_TURN_TIMEOUT_MS = 90_000;

/**
 * How an older cursor-agent — one without {@link CURSOR_TRUST_FLAG} — reports
 * that the FLAG killed the turn. That is not a missing MCP trust, so the probe
 * retries bare rather than recording a fail it did not measure.
 */
export const CURSOR_UNKNOWN_TRUST_OPTION_MESSAGE = `unknown option '${CURSOR_TRUST_FLAG}'`;

// ── Messages ──────────────────────────────────────────────────────────────

/** Fallback for an error `result` line that carries no text of its own. */
export const CURSOR_RUN_FAILED_MESSAGE = 'cursor-agent run failed';

/**
 * cursor-agent has no system-prompt flag, so a graph node's role is prepended
 * to the prompt text with this separator.
 */
export const CURSOR_SYSTEM_PROMPT_SEPARATOR = '\n\n';

/** One line per attached image path. */
export const CURSOR_IMAGE_BULLET = '- ';

export const CURSOR_IMAGE_HEADER_SINGLE = 'The user attached this image file:';
export const CURSOR_IMAGE_HEADER_PLURAL =
  'The user attached these image files:';

// ── The assembled static config ───────────────────────────────────────────
