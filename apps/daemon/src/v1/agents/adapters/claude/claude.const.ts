import type {
  AdapterConfig,
  AgentApprovalMode,
  AgentEffort,
  AgentModel,
} from '../adapter.types';

/**
 * Every constant the `claude` adapter needs, in one place.
 *
 * Nothing about this CLI is spelled as a literal inside `claude.adapter.ts` or
 * any `claude/utils/**` helper — argv flags, timeouts, file names, env var
 * names and user-facing message templates are all named here, grouped by what
 * they are about. The static subset the base class reads is assembled from
 * them by `ClaudeAdapter.getConfig()` — this file holds the VALUES, the
 * adapter holds their shape.
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

/** Utility argv whose stdout is searched for {@link CLAUDE_PARTIAL_MESSAGES_FLAG}. */
export const CLAUDE_HELP_ARGS: readonly string[] = ['--help'];

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

// ── Asking the user ───────────────────────────────────────────────────────

/**
 * Probe-verified: a plain chat turn under `--permission-mode default
 * --permission-prompt-tool stdio` offers this tool, and its request arrives
 * as `can_use_tool` with `requires_user_interaction: true`.
 */
export const CLAUDE_QUESTION_TOOL_NAME = 'AskUserQuestion';

// ── Approval policy ───────────────────────────────────────────────────────

/** Every `--permission-mode` value the CLI exposes, plus the `auto` bypass. */
export const CLAUDE_APPROVAL_MODES = [
  'auto',
  'ask',
  'acceptEdits',
  'plan',
] as const satisfies readonly AgentApprovalMode[];

/**
 * The two modes headless claude has been seen to reject on some builds — so
 * a run requesting either waits out the mode probe, and a run that never
 * does pays nothing.
 */
export const CLAUDE_PROBED_APPROVAL_MODES = [
  'acceptEdits',
  'plan',
] as const satisfies readonly AgentApprovalMode[];

/** `acceptEdits` still runs on a probed FAIL — every edit just asks first. */
export const CLAUDE_ACCEPT_EDITS_DEGRADE_REASON =
  "installed claude does not support acceptEdits — this turn runs as 'ask'";

// ── Reasoning effort ──────────────────────────────────────────────────────

/**
 * The values `claude --effort` accepts, weakest first.
 *
 * WRITTEN DOWN RATHER THAN SCRAPED, because the CLI under-reports itself. Its
 * own `--help` says "Valid values: low, medium, high, xhigh, max" and its
 * warning line repeats that set — but `ultracode` is accepted just as
 * silently as the five it names.
 *
 * Probe-verified on claude 2.1.220 (2026-07-29) by feeding each candidate and
 * testing for the `Unknown --effort value` warning:
 * - accepted, no warning: low, medium, high, xhigh, max, `ultracode`
 * - rejected with the warning: `ultrathink`, and the control `zzz-not-a-level`
 *
 * So a `--help` scrape would drop `ultracode` (a level the user asked for by
 * name), and guessing would never have found it. Re-probe the same way when
 * this list is revised; do not copy it out of help output.
 */
export const CLAUDE_EFFORT_LEVELS: readonly AgentEffort[] = [
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
  { id: 'ultracode', label: 'ultracode' },
];

// ── Models ────────────────────────────────────────────────────────────────

/**
 * The aliases `claude --model` documents: each resolves to the latest model of
 * its tier, so they stay correct across releases without an app update. This
 * is the floor of the list, never the whole of it.
 */
export const CLAUDE_BUILTIN_MODELS: AgentModel[] = [
  { id: 'opus', label: 'opus', source: 'builtin' },
  { id: 'sonnet', label: 'sonnet', source: 'builtin' },
  { id: 'haiku', label: 'haiku', source: 'builtin' },
];

/** The CLI's own config file in `~`, which caches the account's model options. */
export const CLAUDE_MODEL_CACHE_FILE = '.claude.json';

/** The key inside it: `[{ value, label, description }]`. */
export const CLAUDE_MODEL_CACHE_KEY = 'additionalModelOptionsCache';

// ── Skills / commands on disk ─────────────────────────────────────────────

/** `<root>/.claude/skills/<name>/SKILL.md`. */
export const CLAUDE_SKILLS_SEGMENTS: readonly string[] = ['.claude', 'skills'];

/** `<root>/.claude/commands/**.md`. */
export const CLAUDE_COMMANDS_SEGMENTS: readonly string[] = [
  '.claude',
  'commands',
];

// ── Commands the CLI reports about ITSELF ─────────────────────────────────

/** Never reached by the model: the turn is cancelled the moment init lands. */
export const CLAUDE_COMMANDS_PROBE_PROMPT = 'Reply with exactly: ok';

/** A hung probe must not wedge the caller forever. */
export const CLAUDE_COMMANDS_PROBE_TIMEOUT_MS = 30_000;

/** Defensive bound — init reports ~60 entries today. */
export const CLAUDE_MAX_REPORTED_COMMANDS = 500;

/**
 * `_`-prefixed names are claude's INTERNAL commands (`__remote-workflow`) —
 * reported, but not things a user invokes. SkillHarvestStore drops them from
 * the other report path too.
 */
export const CLAUDE_INTERNAL_COMMAND_PREFIX = '_';

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

// ── Interactive terminal mirror ───────────────────────────────────────────

/**
 * What a resumable claude session id looks like. A missing or foreign-shaped
 * id is not a mirror target — opening the TUI without one would start an
 * unrelated fresh conversation instead of showing the run's own.
 */
export const CLAUDE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// ── Messages ──────────────────────────────────────────────────────────────

/** Fallback for an error `result` line that carries no text of its own. */
export const CLAUDE_RUN_FAILED_MESSAGE = 'claude run failed';

/** What the CLI is told when the user denies a permission request. */
export const CLAUDE_DENY_MESSAGE = 'Denied by the user in Geniro';

// ── The assembled static config ───────────────────────────────────────────
