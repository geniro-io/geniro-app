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

/**
 * Loads a plugin for one invocation (`--plugin-dir <path>`, repeatable).
 *
 * A GLOBAL option, which is the whole reason this is a named constant used by
 * two very differently-shaped call sites: on a turn there is no subcommand so
 * it may sit anywhere in argv, but `claude mcp list --plugin-dir X` is
 * REJECTED as an unknown option — before the subcommand is the only placement
 * that works there (probe-verified on 2.1.220).
 */
export const CLAUDE_PLUGIN_DIR_FLAG = '--plugin-dir';

/**
 * Restricts a turn to `--mcp-config` servers only. geniro does NOT pass it:
 * an agent must see the same MCP servers a fresh session in that folder sees,
 * plus geniro's call surface. Named so the spec pinning its absence and any
 * future reader spell it the same way.
 */
export const CLAUDE_STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

// ── The MCP toggle: settings merge semantics ──────────────────────────────
//
// PROBE EVIDENCE, claude 2.1.220, captured in this container. Re-probe before
// trusting any of it on a new claude series — every line below is an
// observation of one build, not a documented contract.
//
// - `--settings <file-or-json>` is documented by the CLI itself as loading
//   "additional settings", and behaves that way: a key set in the project's
//   own `.claude/settings.json` SURVIVED a `--settings` that never mentioned
//   it. It merges; it does not replace.
// - `disabledMcpjsonServers` removes a project `.mcp.json` server from a real
//   turn — the name disappears from the init message's `mcp_servers`.
// - Two `disabledMcpjsonServers` lists from different sources are UNIONed,
//   NOT overridden: the user's own settings disabling `a` plus `--settings`
//   disabling `b` left BOTH gone. So geniro can always switch a server off,
//   and can NEVER switch one back on that the user disabled themselves.
// - `claude mcp list` accepts NO options at all (`--settings` is rejected as
//   an unknown option), so the LISTING can never reflect a toggle. The daemon
//   merges its own disabled set into the rows instead.
// - It is the TURN, not the listing, that auto-approves project servers: the
//   same folder shows them `Pending approval` under `mcp list` while a `-p`
//   turn reports them `connected`.

/** The settings file geniro hands the CLI for one turn. Merged, never replacing. */
export const CLAUDE_SETTINGS_FLAG = '--settings';

/** The settings key holding project-`.mcp.json` servers to leave unloaded. */
export const CLAUDE_DISABLED_MCP_SERVERS_KEY = 'disabledMcpjsonServers';

/** Name parts of one turn's settings file, so a crashed launch's are sweepable. */
export const CLAUDE_SETTINGS_PREFIX = 'geniro-settings-';
export const CLAUDE_SETTINGS_SUFFIX = '.json';

/** The folder's own MCP server definitions — the only disable-able scope. */
export const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';

/**
 * The user's own settings files, resolved against a run's cwd. Read ONLY — a
 * name found in one is a server geniro cannot re-enable, because the CLI
 * unions the disabled lists rather than letting ours override.
 */
export const CLAUDE_PROJECT_SETTINGS_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
] as const;

/** The same, in the user's home directory. */
export const CLAUDE_HOME_SETTINGS_FILE = '.claude/settings.json';

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
 * command HEALTH-CHECKS: it dials every configured server, which means
 * STARTING it — a `docker run` or a `uvx` server that has to fetch before it
 * can answer takes tens of seconds, and an unreachable HTTP one is only known
 * to be unreachable once its own connect times out. Observed on 2.1.220: a
 * warm 11-server folder took ~9s; a cold one is far slower, and 20s here
 * reported "claude did not answer" for a listing that was merely starting up.
 *
 * Bounded ABOVE by the renderer's per-request budget for THIS route
 * (`use-agent-mcp.ts` MCP_LIST_TIMEOUT_MS), which is deliberately longer so the
 * daemon always gives up first and the reason the user reads is the specific
 * one produced here. Raising this past that budget puts the client back in
 * front, and the panel goes back to a bare transport failure.
 */
export const CLAUDE_MCP_LIST_TIMEOUT_MS = 45_000;

/**
 * Row status markers — the WORDING only, deliberately WITHOUT the glyph that
 * precedes it.
 *
 * The glyph is not stable. The same 2.1.220 binary printed U+00D7 MULTIPLICATION
 * SIGN for a failure when driven one way and U+2718 HEAVY BALLOT X when driven
 * another (observed in this container: a daemon spawned under Electron's node
 * gave `×`, the same daemon under host node gave `✘` for the identical
 * server). The CLI evidently picks its decoration from the environment, so
 * pinning one glyph silently downgraded every failed row to `status: 'unknown'`
 * — the row still listed, with its reason intact, but wearing the wrong badge.
 *
 * The wording has held across every observation. Matching it and letting the
 * walk-back in `parseMcpList` discard whatever decoration precedes it is both
 * more robust and less of a guess than enumerating glyphs we have not seen.
 */
export const CLAUDE_MCP_CONNECTED_MARKER = 'Connected';
export const CLAUDE_MCP_FAILED_MARKER = 'Failed to connect';
export const CLAUDE_MCP_PENDING_MARKER = 'Pending approval';

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
