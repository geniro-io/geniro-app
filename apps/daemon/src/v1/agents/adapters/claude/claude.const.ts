/**
 * Every `claude` value read from anywhere except the config literal.
 *
 * A value needed in more than one spot — an argv flag `buildArgs` pushes and a
 * util searches for, a file name a writer and its sweep both spell — is named
 * here precisely so the readers cannot drift apart. Values with a single
 * reader are named here too: the name is where the doc block lives, and
 * `--dangerously-skip-permissions` sitting bare in an argv array explains
 * nothing.
 *
 * The ONE exception is `ClaudeAdapter.getConfig()`. A static fact that literal
 * alone reads is written inline there, beside the field it answers, because a
 * name nothing else ever says buys nothing — it only puts the value one file
 * away from the shape that gives it meaning.
 */

// ── Turn argv ─────────────────────────────────────────────────────────────

/**
 * The invariant head of every turn's argv: `-p` headless, stream-json out,
 * `--verbose` (required for stream-json output), stream-json IN so the prompt
 * can travel as a structured user message on stdin.
 */
export const CLAUDE_BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
];

/** The argv flag that turns whole-block output into token-level deltas. */
export const CLAUDE_PARTIAL_MESSAGES_FLAG = '--include-partial-messages';

export const CLAUDE_MODEL_FLAG = '--model';
export const CLAUDE_EFFORT_FLAG = '--effort';
export const CLAUDE_RESUME_FLAG = '--resume';
export const CLAUDE_APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt';
export const CLAUDE_PERMISSION_MODE_FLAG = '--permission-mode';
export const CLAUDE_PERMISSION_PROMPT_TOOL_FLAG = '--permission-prompt-tool';

/** The CLI's own name for the ask-the-user permission mode. */
export const CLAUDE_PERMISSION_MODE_DEFAULT = 'default';

// ── Stdin control protocol (UNDOCUMENTED — probe evidence) ────────────────
//
// WHERE THESE FIELD NAMES CAME FROM. The stdin control protocol these two
// constants switch on is undocumented by the CLI: the `control_request` /
// `control_response` envelope, the `can_use_tool` subtype, and the
// `requires_user_interaction` flag that discriminates a genuine user question
// from a permission check were all established by DRIVING A LIVE CLI and
// reading what came back — never from published docs.
//
// Probed live on 2.1.202 (M4, the question discriminator) and re-probed on
// 2.1.220 (2026-07-29, the approval envelope + `message.usage` shapes). The
// protocol has held across patch releases within the 2.1 series.
//
// That evidence expires. A release can rename a field and every approval in
// the app starts mis-mapping while the turn still looks healthy, so this
// record is what tells the next reader that the names below and in
// `utils/claude-message.utils.ts` (`mapClaudeMessage`'s `control_request`
// arm) / `claude.adapter.ts` (`buildApprovalResponse`) are observations, not
// a contract — RE-PROBE before trusting them on a new claude series.

/** The permission-prompt transport: the stdin control dialogue. */
export const CLAUDE_PERMISSION_PROMPT_TOOL_STDIO = 'stdio';

/** Bypasses every permission check — and STRIPS the question tool with them. */
export const CLAUDE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

export const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';

/** ONLY our server: the user's global MCP config must not leak into a team turn. */
export const CLAUDE_STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

// ── Models ────────────────────────────────────────────────────────────────

/** The CLI's own config file in `~`, which caches the account's model options. */
export const CLAUDE_MODEL_CACHE_FILE = '.claude.json';

/** The key inside it: `[{ value, label, description }]`. */
export const CLAUDE_MODEL_CACHE_KEY = 'additionalModelOptionsCache';

// ── The permission-mode probe ─────────────────────────────────────────────

/** Never answered: the turn is cancelled the moment the session line lands. */
export const CLAUDE_MODE_PROBE_PROMPT = 'Reply with exactly: ok';

/** A hung probe turn must not wedge the capability read forever. */
export const CLAUDE_MODE_PROBE_TIMEOUT_MS = 30_000;

/**
 * An argv-level rejection of `--permission-mode <value>` is the one GENUINE
 * fail — every other pre-session exit (auth, network, missing binary) is an
 * environmental `unknown` that must not be disk-cached against this version.
 * Both patterns must match the SAME error line: the flag has to be named, and
 * the CLI has to be complaining about the value it was given.
 */
export const CLAUDE_MODE_REJECTION_FLAG_PATTERN = /permission-mode/i;
export const CLAUDE_MODE_REJECTION_VERDICT_PATTERN =
  /invalid|allowed choices|unknown/i;

// ── Agent-to-agent calls (MCP) ────────────────────────────────────────────

/**
 * Default `MCP_TOOL_TIMEOUT` for turns that carry the call tools: a sync
 * call_agent legitimately runs for minutes (a full callee turn), far past the
 * CLI's own default MCP client timeout.
 */
export const CLAUDE_MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

/** The child env var carrying {@link CLAUDE_MCP_TOOL_TIMEOUT_MS}. */
export const CLAUDE_MCP_TOOL_TIMEOUT_ENV = 'MCP_TOOL_TIMEOUT';

/** Fallback directory name under the OS tmpdir for standalone/spec use. */
export const CLAUDE_MCP_CONFIG_DIR_NAME = 'geniro-mcp';

/** Per-turn config file name: `<prefix><uuid><suffix>`, also the sweep's filter. */
export const CLAUDE_MCP_CONFIG_PREFIX = 'mcp-';
export const CLAUDE_MCP_CONFIG_SUFFIX = '.json';

/** The token rides IN the file, so the file is the user's alone. */
export const CLAUDE_MCP_CONFIG_FILE_MODE = 0o600;

// ── MCP server listing (PROBE EVIDENCE — human-readable output) ───────────
//
// WHERE THESE MARKERS CAME FROM. `claude mcp list` has no machine-readable
// mode — `--json` is rejected outright ("error: unknown option '--json'") — so
// the only source is its prose, and these are the exact bytes it printed when
// DRIVEN LIVE on 2.1.220 against servers created for the probe and removed
// after. Two of the three glyphs are not the character they look like: the
// connected mark is U+221A SQUARE ROOT, not a check mark, and the failure mark
// is U+00D7 MULTIPLICATION SIGN, not an ASCII `x`. Typing them by eye is how a
// matcher silently matches nothing.
//
// That evidence expires. A release may reword any of this, and the parser is
// built so it degrades to `status: 'unknown'` rather than throwing or dropping
// the row — a listed server with unreadable health beats a server the user
// cannot see at all. Prefer a structured mode over this the moment one exists.

/** Argv for the folder-scoped server listing. */
export const CLAUDE_MCP_LIST_ARGS: readonly string[] = ['mcp', 'list'];

/**
 * Deadline for that listing. Far above the 10s utility default because the
 * command HEALTH-CHECKS: it dials every configured server, and an unreachable
 * HTTP one is only known to be unreachable once its own connect times out.
 *
 * Bounded ABOVE by the renderer's own 30s per-request budget
 * (`daemon-api.ts` REQUEST_TIMEOUT_MS), which starts strictly earlier and
 * covers the version probe too: at 30s here the client always aborted first,
 * so the daemon's "could not read" sentence never reached the panel and the
 * user was told "No servers" for a folder that had some.
 */
export const CLAUDE_MCP_LIST_TIMEOUT_MS = 20_000;

/** Row status markers, longest-lived part of the format. */
export const CLAUDE_MCP_CONNECTED_MARKER = '√ Connected';
export const CLAUDE_MCP_FAILED_MARKER = '× Failed to connect';
export const CLAUDE_MCP_PENDING_MARKER = '⏸ Pending approval';

/** Separates `Failed to connect` from the reason (U+2014 EM DASH). */
export const CLAUDE_MCP_DETAIL_SEPARATOR = '—';

/**
 * Shown to the user when the listing command could not be run at all — a
 * missing binary, a non-zero exit, or the deadline. Deliberately distinct from
 * an empty listing: only one of the two is a fact about their configuration.
 */
export const CLAUDE_MCP_LIST_FAILED_MESSAGE =
  'could not read MCP servers — claude did not answer';

/**
 * Printed INSTEAD of any rows when the folder has none. It is the only thing
 * that tells an empty folder apart from output this parser could not read at
 * all — without it, a release that reworded the row format would drop every
 * row and be indistinguishable from "you have no servers configured".
 */
export const CLAUDE_MCP_EMPTY_MARKER = 'No MCP servers configured';

/** Shown when the CLI answered but nothing in its output looked like a row. */
export const CLAUDE_MCP_LIST_UNREADABLE_MESSAGE =
  'could not read MCP servers — the claude output format may have changed';

// ── Messages ──────────────────────────────────────────────────────────────

/** Fallback for an error `result` line that carries no text of its own. */
export const CLAUDE_RUN_FAILED_MESSAGE = 'claude run failed';

/** What the CLI is told when the user denies a permission request. */
export const CLAUDE_DENY_MESSAGE = 'Denied by the user in Geniro';
