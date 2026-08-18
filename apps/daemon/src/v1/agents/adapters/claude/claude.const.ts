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

// ── The conversations this CLI keeps on disk ───────────────────────────────
/**
 * Where a profile stores them: `<configDir>/projects/<flattened cwd>/<id>.jsonl`.
 * Named because the listing and the transcript read both walk it, and a second
 * spelling is how one of them would come to look in the wrong place.
 */
export const CLAUDE_SESSIONS_DIR_NAME = 'projects';
/**
 * Where this CLI keeps its profile when no `CLAUDE_CONFIG_DIR` names one —
 * `~/.claude`. The same directory `skillRoots` and the settings reader reach
 * into; named here because the session scan needs it as a ROOT rather than as
 * the first segment of a path to one file.
 */
export const CLAUDE_DEFAULT_PROFILE_DIR = '.claude';
/** One session is one file, and the id is the file name without this. */
export const CLAUDE_SESSION_FILE_SUFFIX = '.jsonl';
/**
 * How far into a session file the listing reads to find its folder and its
 * opening prompt.
 *
 * A budget rather than a line count, because the first lines are not small: a
 * session opens with hook output and system-reminder blocks, and in this
 * profile's own files the first real user message routinely sits 20–40KB in.
 * 256KB clears that with room to spare while keeping a 2,448-session profile to
 * a listing measured in hundreds of milliseconds.
 */
export const CLAUDE_SESSION_HEAD_BUDGET_BYTES = 256 * 1024;
/** How much of that prompt a picker row shows before it is elided. */
export const CLAUDE_SESSION_TITLE_MAX_CHARS = 120;
export const CLAUDE_APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt';
export const CLAUDE_PERMISSION_MODE_FLAG = '--permission-mode';
export const CLAUDE_PERMISSION_PROMPT_TOOL_FLAG = '--permission-prompt-tool';

/**
 * The CLI's own name for the ask-the-user permission mode.
 *
 * `--help` on 2.1.227 no longer LISTS this value — its choices are
 * `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`, with
 * `manual` in its place. It is kept anyway, and deliberately not renamed:
 * probed on 2.1.227, `--permission-mode default` is still accepted (exit 0),
 * and BOTH spellings make the CLI report `permissionMode: "default"` back on
 * its `system/init` line. So `default` is the canonical internal name and
 * `manual` is the surfaced alias — chasing the alias would swap a name the CLI
 * answers with for one it only accepts.
 */
export const CLAUDE_PERMISSION_MODE_DEFAULT = 'default';

/**
 * The mode named on argv when a turn holding the permission dialogue somehow
 * carries no `approvalMode` — the type permits it, so the argv answers it
 * rather than letting a `--permission-mode undefined` reach the CLI.
 *
 * WHY THE UNSET CASE STOPPED BEING FREE. A turn with no mode passes no
 * `--permission-mode` at all and inherits whatever the installed CLI defaults
 * to. That was safe while claude's default was `default` (ask about
 * everything); it is not any more. Probed on 2.1.227: a `-p` turn with NO
 * permission flag reports `permissionMode: "auto"`, the new default Anthropic
 * is rolling out to Pro/Max/Team sessions. Inheriting it turns "nobody chose a
 * posture" into "approve everything unattended", decided by the vendor and
 * never seen by the user.
 *
 * The USER-facing half of that is fixed where a null mode actually has a
 * meaning — `ChatService` resolves a pre-selector chat row's null `approval`
 * to `ask` before the turn is built. It is deliberately NOT fixed here: the
 * same `undefined` also reaches this adapter from geniro's own probe turns,
 * which read one `system/init` line and are cancelled, and handing those a
 * permission dialogue and an open stdin buys nothing. So an unset mode still
 * means "no permission flags" (see `spawnsOnPermissionDialogue`), and this
 * constant only names the value for the branch that cannot be reached with an
 * unset mode today.
 */
export const CLAUDE_UNSET_MODE_FALLBACK = CLAUDE_PERMISSION_MODE_DEFAULT;

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

/**
 * Bypasses every permission check — and STRIPS the question tool with them.
 *
 * Re-probed on 2.1.227 by reading `system/init`'s own `tools` list, which
 * sharpens WHY. It is not the bypass that removes `AskUserQuestion`; it is the
 * absence of a permission-prompt CHANNEL. Measured across every mode: with
 * `--permission-prompt-tool stdio` the tool is present under `default`,
 * `manual`, `acceptEdits`, `plan`, `auto` and `dontAsk` alike, and without it
 * the tool is absent under every one of those too — the mode is not the
 * variable. This flag strips it because a turn that asks nobody for permission
 * is given no channel to ask on.
 *
 * That distinction matters for the workaround in `buildArgs`, which is
 * unchanged and still correct: an `auto` turn that must be able to ask spawns
 * on `default` + stdio, and the probe confirms the tool is there. It also rules
 * out the tempting shortcut of keeping the bypass and adding stdio to it —
 * that combination does register the tool, but the same probe measured the
 * turn's whole tool surface collapsing from 207 entries to 91.
 */
export const CLAUDE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * The control subtype that re-modes a turn ALREADY RUNNING.
 *
 * The one client-INITIATED control request the daemon sends; every other line
 * on this dialogue answers something the CLI asked first. Probed live on
 * 2.1.222: written mid-turn it was acknowledged in ~2ms, and the CLI re-emitted
 * `system/init` with the new `permissionMode` ~350ms later — so the change
 * lands on the turn in flight rather than on the next one.
 *
 *     --> {"type":"control_request","request_id":"…",
 *          "request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
 *     <-- control_response success {"mode":"acceptEdits"}
 *
 * Same expiry warning as the block above: an observation, not a contract.
 */
export const CLAUDE_SET_PERMISSION_MODE_SUBTYPE = 'set_permission_mode';

/**
 * The client-initiated control request that stops the turn in flight WITHOUT
 * stopping the process — the difference a run-scoped session is built on.
 *
 * Probed live on 2.1.223: acknowledged in ~2ms, the turn then ended with
 * `result subtype=error_during_execution`, and the process kept running with
 * its MCP servers up. Killing the process group instead is what takes those
 * servers — and a browser one of them owns — down with a turn the user only
 * meant to stop.
 *
 *     --> {"type":"control_request","request_id":"…",
 *          "request":{"subtype":"interrupt"}}
 *     <-- control_response success {"still_queued":[]}
 *
 * Same expiry warning as the blocks above: an observation, not a contract —
 * which is why the cancel path keeps a deadline behind it.
 */
export const CLAUDE_INTERRUPT_SUBTYPE = 'interrupt';

/**
 * Prefix for the request ids the DAEMON mints, keeping them out of the id
 * space the CLI mints for its own `can_use_tool` requests. Both travel the one
 * dialogue, and a collision would route the CLI's answer to our request into
 * the approval registry as though a tool had been decided.
 */
export const CLAUDE_CONTROL_REQUEST_ID_PREFIX = 'geniro-';

export const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';

/**
 * Points claude at a different config directory — the folder holding its
 * credentials, settings, installed plugins and session history, i.e. WHICH
 * ACCOUNT the invocation runs as.
 *
 * ENV, not a flag: claude exposes no `--config-dir`, and this is the documented
 * knob its own SDK guidance names. Probe-verified on 2.1.227 — pointed at an
 * empty directory, a headless `claude -p` wrote `.claude.json`, `projects/` and
 * `sessions/` into it and ended "Not logged in · Please run /login", which is
 * the whole mechanism in one observation: a separate directory is a separate
 * signed-in profile.
 *
 * Named here rather than written inline because two call sites spell it — a
 * turn's `buildEnv` and the `mcp list` read, which must be taken under the SAME
 * profile it describes.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Gives a HEADLESS turn this CLI's own `Artifact` tool — the thing it publishes
 * a page to claude.ai with.
 *
 * Restoring parity, not enabling a feature geniro invented: the account these
 * chats run as already holds published artifacts (`https://claude.ai/code/
 * artifact/<uuid>`), made from that CLI's interactive sessions. It is only the
 * headless mode geniro drives that ships without the tool, so an agent asked
 * for one answered that "this session cannot publish" — with nothing on screen
 * to say why, which is what got reported.
 *
 * Probe-verified on 2.1.234, reading `system/init`'s own tool list under the
 * exact argv a chat turn uses: two runs minutes apart differed by exactly one
 * tool, `Artifact`, present only in the one carrying this variable. Its sibling
 * settings key (`enableArtifact` in a `--settings` file) was probed too and
 * does NOT work — the CLI gates that key behind a per-account flag of its own,
 * so the environment is the only lever geniro has.
 *
 * Undocumented, so treat this as a MEASUREMENT with an expiry: when the CLI
 * ships the tool to headless sessions by itself, this line becomes a no-op and
 * should go. The value is only ever read as "is it set" — `1` is the spelling
 * the CLI's own truthiness check accepts.
 */
export const CLAUDE_ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT';

/**
 * Gives a headless turn this CLI's own TASK tools — `TaskCreate`, `TaskUpdate`,
 * `TaskGet`, `TaskList` — the checklist it keeps while working a multi-step job.
 *
 * Same shape of loss as {@link CLAUDE_ARTIFACT_ENV} and a sharper consequence
 * here, because geniro already RENDERS that list: `claude-tasks.utils.ts` reads
 * it off both directions of those very tool calls, and the transcript's task
 * card and the side panel's rows are built from it. Without the tools the CLI
 * never announces a list, so a feature the app ships could not fire on claude
 * at all — a multi-step job showed anonymous tool rows instead.
 *
 * Probe-verified on 2.1.234 the same way as the artifact one: the same argv,
 * with and without, differing by exactly those four names.
 */
export const CLAUDE_TODO_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

/**
 * Gives a turn the **Claude in Chrome** tools — the 22
 * `mcp__claude-in-chrome__*` names (navigate, read_page, find, form_input,
 * javascript_tool, tabs, console/network readers, screenshots…) that drive the
 * user's own browser through Anthropic's Chrome extension.
 *
 * Probe-verified on 2.1.234: absent from a headless turn's tool list, and all
 * 22 present with this set.
 *
 * OFF unless the user asks for it, which is the difference from the two above.
 * They restore a handful of tools that work on their own; this one registers a
 * whole toolbelt that does nothing at all without the extension installed and a
 * browser running it — and it is 22 tool schemas in every prompt of every turn,
 * paid for on each. So it rides a setting (`claudeBrowserTools`), reaching the
 * daemon as `GENIRO_CLAUDE_BROWSER_TOOLS` and this adapter as one boolean.
 */
export const CLAUDE_BROWSER_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_CFC';

/**
 * How the UI asks for the tools above: set on the DAEMON's env when the
 * `claudeBrowserTools` setting is on.
 *
 * GENIRO_-prefixed, so `buildChildEnv` strips it from every spawned child — the
 * daemon reads it here and hands the CLI its OWN variable instead, which is the
 * same shape as the binary override in `utils/agent-binary.ts`.
 */
export const CLAUDE_BROWSER_TOOLS_SETTING_ENV = 'GENIRO_CLAUDE_BROWSER_TOOLS';

/**
 * Restricts a turn to `--mcp-config` servers only.
 *
 * NEVER passed on a turn of the user's: an agent must see the same MCP servers
 * a fresh session in that folder sees, plus geniro's call surface. It is passed
 * on exactly one path — a turn the daemon runs for its own bookkeeping and
 * cancels before the model runs (`AgentTurnInput.isolateMcpServers`), where
 * loading the user's servers only to reap them is pure cost.
 */
export const CLAUDE_STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

/**
 * The `--mcp-config` value that defines no servers at all.
 *
 * Passed WITH {@link CLAUDE_STRICT_MCP_CONFIG_FLAG} rather than relying on the
 * flag alone, so the restriction has an explicit empty set to restrict to
 * rather than depending on how the CLI reads a strict flag with no config
 * beside it. The flag takes inline JSON as readily as a path, so this needs no
 * temp file to be cleaned up.
 *
 * Probe-verified on claude 2.1.223: this argv is accepted, the `init` line
 * comes back with `mcp_servers: []` — no server of the user's was started —
 * and it still reports all 59 `slash_commands`, which is the only thing the
 * probe reading it wants.
 */
export const CLAUDE_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

// ── The MCP toggle ────────────────────────────────────────────────────────
//
// PROBE EVIDENCE, claude 2.1.220 and 2.1.222, captured on this machine.
// Re-probe before trusting any of it on a new claude series — every line below
// is an observation of one build, not a documented contract.
//
// - `projects[<cwd>].disabledMcpServers` in the home config takes a server out
//   of a real turn WHATEVER SCOPE DEFINED IT (2.1.222, isolated
//   CLAUDE_CONFIG_DIR, `local`-scope server: `status: 'failed'` without the
//   key, `status: 'disabled'` with it). This is the toggle geniro writes.
// - `disabledMcpjsonServers` is a different list: it REJECTS a project
//   `.mcp.json` server, and every source's copy of it is UNIONed rather than
//   overridden — so nothing geniro writes can put such a server back.
// - `claude mcp list` accepts NO options at all, and reports a disabled server
//   as though it were live, so the LISTING can never reflect the toggle. The
//   daemon merges the config's own disabled set into the rows instead.
// - It is the TURN, not the listing, that auto-approves project servers: the
//   same folder shows them `Pending approval` under `mcp list` while a `-p`
//   turn reports them `connected`.

/**
 * The CLI's OWN per-folder disable list, and the mechanism geniro's toggle
 * uses: `~/.claude.json` → `projects[<cwd>].disabledMcpServers`.
 *
 * PROBE-VERIFIED on 2.1.222, in an isolated `CLAUDE_CONFIG_DIR` with a
 * `local`-scope server — the scope the old settings-file route could never
 * reach:
 *
 *   without the key   → init `mcp_servers: [{name: 'probe-server', status: 'failed'}]`
 *   with the key      → init `mcp_servers: [{name: 'probe-server', status: 'disabled'}]`
 *
 * It covers servers of EVERY scope, which `disabledMcpjsonServers` (below) does
 * not — that one only rejects a project `.mcp.json` server. This is what the
 * CLI's own `/mcp` panel writes, so a switch flipped here is the same switch
 * the user sees in their terminal, and vice versa.
 */
export const CLAUDE_HOME_DISABLED_MCP_KEY = 'disabledMcpServers';

/**
 * The `.mcp.json` REJECTION list, in settings and in the home config.
 *
 * Read-only for geniro: a name here is one the user (or the CLI's own trust
 * prompt) turned down, and the CLI unions every source's copy of this list
 * rather than letting a later one override — so nothing geniro writes can put
 * such a server back. It is a different question from
 * {@link CLAUDE_HOME_DISABLED_MCP_KEY}: approval, not loading.
 */
export const CLAUDE_DISABLED_MCP_SERVERS_KEY = 'disabledMcpjsonServers';

/** The folder's own MCP server definitions. */
export const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';

/**
 * The lock geniro takes before editing the CLI's home config.
 *
 * `proper-lockfile`'s default artifact for a path is `<path>.lock`, and the CLI
 * passes exactly that as its own `lockfilePath` — its `ELOCKED` and
 * "Config lock compromised" strings are that package's. Naming the suffix here
 * is what keeps the two processes on the SAME lock: a different path would
 * still lock, and would still let both write at once.
 */
export const CLAUDE_CONFIG_LOCK_SUFFIX = '.lock';

/**
 * Retries while another claude process holds the config lock. Each write is a
 * parse and a rename of a small file, so contention is brief — but a user
 * typing in their own CLI while the panel toggles is entirely ordinary, and
 * failing the toggle at the first collision would surface as a switch that
 * randomly does nothing.
 */
export const CLAUDE_CONFIG_LOCK_RETRIES = 10;

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

// ── The MCP readiness gate (PROBE EVIDENCE — undocumented control subtype) ──
//
// THE DEFECT THIS EXISTS FOR. "I have playwright in mcp servers list … But
// agent cant use it" — reported with two screenshots: geniro's MCP panel with
// `playwright` green, and the agent in the same folder replying "the Playwright
// MCP server isn't loaded in this session", inventing a config reason for it
// (the server is a `local`-scope entry under two OTHER projects). Both the
// panel and the agent were reporting honestly; the panel is right and the
// agent's session really did not have the tools.
//
// WHAT IS ACTUALLY HAPPENING, measured on 2.1.232 in the author's own folder
// (45 servers). The CLI dials its MCP servers when the PROCESS starts and does
// NOT wait for them before running a turn, so a turn that begins ~3s in is
// given whatever has connected by then:
//
//   prompt written at 0s → init at 3.1s: 8 servers `pending`, 148 tools,
//                                        0 of them playwright's
//   prompt held to 8s    → init at 8.1s: 0 pending, 466 tools, 24 playwright
//
// Nothing is permanently missing — the surface GROWS mid-turn (probed: a server
// `pending` at init answered a tool call 29s later). The damage is that the
// model asks once, at second three, is told the tool does not exist, and
// reasons from that for the rest of the conversation. That is why it presents
// as "the agent can't use it" and why it is intermittent — it is a race with
// however long each server takes to dial.
//
// THE ORACLE. `mcp_status` is a client-initiated control request on the same
// stdin dialogue as `can_use_tool` — undocumented, found by enumerating the
// subtypes in the shipped binary and then DRIVEN LIVE. It answers before any
// prompt has been written, which is what makes a gate possible at all:
//
//     --> {"type":"control_request","request_id":"…",
//          "request":{"subtype":"mcp_status"}}
//     <-- {"type":"control_response","response":{"subtype":"success",
//          "request_id":"…","response":{"mcpServers":[
//            {"name":"playwright","status":"pending","config":{…},"scope":"user"},
//            …]}}}
//
// Observed on 2.1.232, polling every 400ms from spawn: n=6/5 pending at 0.8s,
// n=45/14 at 1.2s, 0 pending at 6.0s, and the turn released at 6.4s reported
// `pending: []` and 466 tools at init. Same expiry warning as the other probe
// blocks in this file: an observation of one build, not a contract. If a later
// release renames the subtype or the reply, the gate degrades to "no oracle,
// send the prompt now" — which is exactly today's behaviour, so a rename costs
// the fix and never the turn.

/** The control subtype that reports every MCP server's live connection state. */
export const CLAUDE_MCP_STATUS_SUBTYPE = 'mcp_status';

/** The key its reply carries the rows under — `mcpServers`, not `servers`. */
export const CLAUDE_MCP_STATUS_ROWS_KEY = 'mcpServers';

/** The one row status that means "still dialling"; every other is settled. */
export const CLAUDE_MCP_STATUS_PENDING = 'pending';

/**
 * Gap between readiness polls. Small enough that the gate releases within a
 * poll of the last server settling (measured: the servers went quiet at 6.0s
 * and the prompt went out at 6.4s), large enough not to spin.
 */
export const CLAUDE_MCP_READY_POLL_MS = 400;

/**
 * How long ONE poll waits for its answer before the gate asks again.
 *
 * Silence is not refusal, and conflating the two cost the gate its first
 * observed run: a cold CLI left the opening poll unanswered, and a gate that
 * treated that as "this build has no such subtype" gave up permanently on a
 * CLI that answers every later poll in well under a second. So an unanswered
 * poll is read as an EMPTY reading — the same "we do not know yet" an empty
 * server list means — and the empty grace below is what bounds a CLI that
 * really never answers. Only an explicit error reply is a refusal.
 */
export const CLAUDE_MCP_READY_REPLY_TIMEOUT_MS = 1_200;

/**
 * How long an EMPTY reading is believed before the gate concludes the machine
 * simply has no MCP servers.
 *
 * The list is not empty because nothing is configured — it is empty because
 * discovery has not finished. Measured, the first non-empty reading landed at
 * 0.77–0.8s across runs, so this is generous; a user with no servers at all
 * pays it once per session process and nothing after.
 */
export const CLAUDE_MCP_READY_EMPTY_GRACE_MS = 2_000;

/**
 * How long the gate waits WITHOUT PROGRESS before giving up — a stall window,
 * not a flat ceiling.
 *
 * A server that never leaves `pending` — a broken command, an unreachable host
 * — must not hold the user's first message forever, so once nothing has
 * CHANGED for this long the prompt goes out with a notice naming what was still
 * starting. Set above the 6s the author's own 45-server folder took, and far
 * below the turn's silence deadline, which is the backstop behind it.
 *
 * It used to be the whole ceiling, measured from the first poll, and that is
 * what put "these MCP servers were still starting" on a real turn: remote
 * servers (claude.ai, Amplitude) had not finished dialling at 15s, so their
 * tools were missing from the message even though discovery was visibly still
 * making progress. Timing the STALL rather than the total keeps the impatience
 * pointed at what it was for — a server that is stuck — while a slow one that
 * is still moving gets to finish.
 */
export const CLAUDE_MCP_READY_STALL_MS = 15_000;

/**
 * The hard ceiling behind the stall window, so a folder whose servers report
 * churn forever still cannot hold the first message indefinitely.
 *
 * Only reachable by a folder that keeps CHANGING its reading for a full minute
 * without ever settling; anything healthy releases the moment two identical
 * readings show nothing pending, which is usually seconds.
 */
export const CLAUDE_MCP_READY_MAX_WAIT_MS = 60_000;

/**
 * Said out loud when the deadline expires with servers still dialling: `%s` is
 * the comma-separated list. Without it the turn would silently be the old
 * broken one, which is the report this whole block exists for.
 */
export const CLAUDE_MCP_NOT_READY_MESSAGE =
  'these MCP servers were still starting when this turn began, so their tools are missing from it: %s. They will be available from your next message.';

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

/**
 * An OAuth server the CLI holds no credentials for. Probe-verified on 2.1.223,
 * driven live against a `mcp add --transport http` server in a throwaway folder:
 *
 *     probe-linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication
 *
 * `claude mcp get` prints the same wording as its `Status:`. The glyph is `!`
 * and is excluded for the same reason the other three are — see the block above.
 *
 * Its absence was a live defect, not a gap: the row parsed, matched no marker,
 * and came out `status: 'unknown'` with the wording as its detail — which the
 * panel then did not render at all, since it shows a detail only for `failed`.
 * A server one command away from working therefore appeared as a row with an
 * unexplained badge and nothing to do about it.
 */
export const CLAUDE_MCP_NEEDS_AUTH_MARKER = 'Needs authentication';

/**
 * Argv that signs the CLI in to one server, with the server name appended.
 *
 * Named rather than written inline because it has the second reader that earns
 * a name: `getConfig()` spells it, and the adapter's spec asserts on it.
 */
/**
 * Argv for the ONE-server health probe, and the label its status line carries.
 *
 * `claude mcp get <name>` — and this is a health probe by the CLI's own account,
 * not by inference: `claude mcp get --help` says "Unapproved .mcp.json servers
 * are shown as ⏸ Pending approval and not connected to; approved servers are
 * health-checked."
 *
 * Captured on 2.1.228, with the timings that make it worth having — one server
 * against a folder listing that takes 45s worth of budget for all of them:
 *
 * ```
 * $ claude mcp get codegraph                       # exit 0, 1.56s
 * codegraph:
 *   Scope: User config (available in all your projects)
 *   Status: ✔ Connected
 *   Type: stdio
 *
 * $ claude mcp get ticktick                        # exit 0, 8.10s
 *   Status: ! Connected · tools fetch failed
 *
 * $ claude mcp get telegram                        # exit 1
 * No MCP server named "telegram". Configured servers: …
 * ```
 *
 * The status WORDING is the same vocabulary `mcp list` prints, which is why
 * `parseMcpGetHealth` shares this CLI's existing markers instead of adding a
 * second set — see that function.
 *
 * RE-CHECK IF: `mcp get` stops printing a `Status:` line, or starts reporting a
 * state `mcp list` never produces.
 */
export const CLAUDE_MCP_GET_ARGS: readonly string[] = ['mcp', 'get'];
export const CLAUDE_MCP_GET_STATUS_LABEL = 'Status:';

/**
 * Deadline for that probe. One server, so it is bounded by one connect timeout
 * rather than the slowest of forty-five — but a server whose tools fetch hangs
 * still spends its own (8.1s measured), so this keeps real headroom while
 * staying well under the listing's budget.
 */
export const CLAUDE_MCP_GET_TIMEOUT_MS = 20_000;

export const CLAUDE_MCP_LOGIN_ARGS: readonly string[] = ['mcp', 'login'];

/**
 * What this CLI says when a server sign-in did not complete — see
 * `AdapterConfig.mcp.loginFailureMarkers` for why the verdict has to be read
 * out of the words rather than off an exit status.
 *
 * Observed verbatim on 2.1.232: `Couldn't complete authentication for
 * "probe": stdin isn't a terminal…`. The apostrophe is left out of the marker
 * on purpose — this CLI writes typographic punctuation elsewhere, and a marker
 * carrying one would stop matching the day the line is re-quoted.
 */
export const CLAUDE_MCP_LOGIN_FAILURE_MARKERS: readonly string[] = [
  'complete authentication for',
];

/**
 * Argv that signs the CLI ITSELF in — the account, not one of its MCP servers.
 *
 * `claude auth login` ("Sign in to your Anthropic account"), read from the
 * binary's own `claude auth --help` on 2.1.227. Distinct from
 * {@link CLAUDE_MCP_LOGIN_ARGS} above and reached by a different failure: a
 * turn that ended in "OAuth session expired and could not be refreshed" needs
 * THIS one, and `mcp login` would send the user to a command that cannot fix
 * what they hit.
 *
 * Named for the same reason as its MCP sibling: `getConfig()` spells it and the
 * adapter's spec asserts on it.
 */
export const CLAUDE_AUTH_LOGIN_ARGS: readonly string[] = ['auth', 'login'];

/**
 * Argv that signs the CLI ITSELF out — the counterpart to
 * {@link CLAUDE_AUTH_LOGIN_ARGS}.
 *
 * `claude auth logout` ("Log out from your Anthropic account"), read from
 * `claude auth --help` on 2.1.227. It exists so the Settings card can offer the
 * action that matches the state it is reporting: a CLI the probe found SIGNED
 * IN has nothing to sign in to, and offering it anyway reads as an unfinished
 * setup step.
 *
 * Named for the same reason as its login sibling: `getConfig()` spells it and
 * the adapter's spec asserts on it.
 */
export const CLAUDE_AUTH_LOGOUT_ARGS: readonly string[] = ['auth', 'logout'];

/**
 * Output that means `claude auth login` has reached the point where a pasted
 * code would be accepted.
 *
 * Named rather than inline because it has the second reader that earns a name:
 * `getConfig()` spells it and the adapter's spec asserts on it. Matched
 * case-insensitively and as a SUBSTRING, so the trailing `>` and any
 * re-punctuation of the sentence do not break it — the words are the stable part.
 */
export const CLAUDE_LOGIN_CODE_PROMPT_MARKERS: readonly string[] = [
  'paste code here',
];

/**
 * Wording that marks a turn as having failed on the ACCOUNT, not on the work.
 *
 * Observed verbatim in a failed run's own error row:
 *
 * ```
 * Failed to authenticate: OAuth session expired and could not be refreshed
 * ```
 *
 * The matching half of that sentence only. An earlier revision also carried the
 * bare prefix `'Failed to authenticate'`, which reads as the more robust choice
 * and is the opposite: the CLI uses that same prefix for an MCP SERVER it could
 * not authenticate, and the row would then offer `claude auth login` for a
 * failure only `claude mcp login <server>` can fix — the precise misdirection
 * {@link AdapterConfig.auth} warns about, since a wrong cure is worse than none.
 *
 * A list rather than one string because the account can fail in more than one
 * way (a revoked token, a missing key), but each entry must be specific to the
 * ACCOUNT. Add one only from a real failed turn, never from the CLI's `--help`.
 */
export const CLAUDE_AUTH_EXPIRED_MARKERS: readonly string[] = [
  'OAuth session expired',
  /*
   * The other half, and the commoner one: a profile that is not signed in at
   * all, rather than one whose session lapsed. Observed verbatim on 2.1.232 as
   * a run's whole error row, by pointing a chat at an empty `configDir`:
   *
   * ```
   * Not logged in · Please run /login
   * ```
   *
   * The run settled `failed` correctly and offered no cure, which is the case
   * a Sign-in control exists for — it is exactly reachable by mistyping a
   * config directory, since the CLI creates whatever path it is handed rather
   * than refusing an unknown one.
   *
   * `Please run /login` and not the bare `Not logged in`, for the reason the
   * entry above records: `/login` is the CLI's own command for the ACCOUNT,
   * while "not logged in" is wording that could equally describe an MCP server
   * — and pointing the user at `claude auth login` for a server only
   * `claude mcp login <server>` can fix is the misdirection this list must
   * never introduce.
   */
  'Please run /login',
];

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

// ── Context compaction ────────────────────────────────────────────────────

/**
 * The `system` subtype announcing that the CLI compacted the conversation.
 *
 * It marks the START of the new, compacted segment, so by the time it arrives
 * the work is finished — it is the FINISHED end of the compaction, and it
 * carries the token counts (`compact_metadata`).
 *
 * This block used to say a live "compacting…" state was unobtainable from the
 * headless stream, on 2.1.226 binary evidence that the TUI's internal
 * `compact_start` / `compact_progress` / `compact_end` events are never
 * serialized. That is still true of those three events, and STILL no reason to
 * infer a label from a timer or a silence heuristic — but it is no longer the
 * whole picture: 2.1.227 serializes a plain status line instead. See
 * {@link CLAUDE_COMPACTING_STATUS}.
 */
export const CLAUDE_COMPACT_BOUNDARY_SUBTYPE = 'compact_boundary';

/**
 * The `system` subtype carrying a coarse turn status, of which compaction is
 * the one this daemon reads.
 *
 * Probed on 2.1.227 by driving ONE persistent
 * `-p --output-format stream-json --input-format stream-json` process — the
 * same shape `AgentSessionRegistry` keeps between turns — for 8 turns and then
 * sending `/compact` on its still-open stdin:
 *
 * ```
 * {"type":"system","subtype":"status","status":"compacting","session_id":…}
 * {"type":"system","subtype":"status","status":null,"compact_result":"success"}
 * {"type":"system","subtype":"compact_boundary","compact_metadata":{…,"duration_ms":46594}}
 * ```
 *
 * A FAILED compaction replaces the second line's result with
 * `"compact_result":"failed","compact_error":"Not enough messages to compact."`.
 *
 * Note for anyone re-probing: a ONE-SHOT `claude -p --resume <id> "/compact"`
 * can never succeed — measured refusing at 2 turns, at 10 turns, and on a
 * single 117 000-character turn, always "Not enough messages to compact.". Only
 * the persistent-stdin session compacts, so the one-shot form makes a working
 * feature look broken.
 */
export const CLAUDE_STATUS_SUBTYPE = 'status';

/** The {@link CLAUDE_STATUS_SUBTYPE} value meaning "compacting right now". */
export const CLAUDE_COMPACTING_STATUS = 'compacting';

/** The terminating status line's `compact_result` value meaning it did not happen. */
export const CLAUDE_COMPACT_RESULT_FAILED = 'failed';

/**
 * Said out loud when a compaction the user asked for did not happen. The CLI
 * reports the reason on the same line (`compact_error`), and without this the
 * turn simply carries on at full context with nothing on screen — the user
 * waited for a compaction that silently never occurred.
 */
export const CLAUDE_COMPACT_FAILED_NOTICE =
  'the conversation was not compacted';

// ── Background tasks (delegates that outlive the turn) ────────────────────

/**
 * The `system` subtypes bracketing one background task's life.
 *
 * Probed on 2.1.231 against a turn told to launch a delegate and NOT wait for
 * it (`-p --output-format stream-json --verbose`). One task produces:
 *
 * ```
 * {"type":"system","subtype":"task_started","task_id":"ad83f0a35d8a3dfc9",…}
 * {"type":"system","subtype":"task_progress","task_id":"ad83f0a35d8a3dfc9",…}
 * {"type":"system","subtype":"task_updated","task_id":"…","patch":{"status":"completed",…}}
 * {"type":"system","subtype":"task_notification","task_id":"…","status":"completed",…}
 * ```
 *
 * Why the turn has to care: the SAME probe printed TWO `result` lines. The
 * first is the answer to the user's prompt (`result:"LAUNCHED"`, `num_turns:2`);
 * the second is a turn claude ran ON ITS OWN because a task reported, and it
 * says so — `origin:{kind:"task-notification"}`. So a `result` is the end of
 * what the agent was SAYING, never of what the process is DOING, and a turn
 * settled on it hands the rest to nobody. See `AgentEvent`'s `background_work`
 * for the measured cost of that.
 *
 * Both terminal channels are mapped rather than the tidier one alone: they
 * carry the status in DIFFERENT places (`patch.status` vs `status`) and report
 * different vocabularies for one outcome (`killed` vs `stopped` for the same
 * task, measured in one run), so reading either alone means trusting one
 * spelling of a fact the CLI states twice. The event is keyed by task id and
 * idempotent, so mapping both costs nothing.
 */
export const CLAUDE_TASK_STARTED_SUBTYPE = 'task_started';
/** @see CLAUDE_TASK_STARTED_SUBTYPE */
export const CLAUDE_TASK_UPDATED_SUBTYPE = 'task_updated';
/** @see CLAUDE_TASK_STARTED_SUBTYPE */
export const CLAUDE_TASK_NOTIFICATION_SUBTYPE = 'task_notification';

/**
 * This CLI's `task_type` for a unit of background work that IS a delegate.
 *
 * Named because the mapper and its spec both spell it, and because the
 * distinction is the whole point: probed 2026-08-17 on 2.1.232, one Task call
 * produced a `task_started` with `task_type:'local_agent'` (the delegate) and a
 * second with `task_type:'local_bash'` and `owned_by_subagent:true` (the shell
 * command that delegate then ran). Both are background work the turn must
 * outlive; only the first is a sub-agent anything should count or draw.
 */
export const CLAUDE_TASK_TYPE_AGENT = 'local_agent';

/**
 * Task statuses meaning the work is OVER, however it ended.
 *
 * An allowlist, not a "not running" test, and the direction matters: an
 * unrecognised status leaves the task open, so a vocabulary this list has not
 * caught up with delays a settle (bounded by the turn's silence deadline) rather
 * than declaring finished work that is still running — which is the defect the
 * whole mechanism exists to remove. Observed on 2.1.231: `completed`, `killed`
 * (as `task_updated.patch.status`) and `completed`, `stopped` (as
 * `task_notification.status`) for the same two tasks; the rest are the shapes
 * the same field takes elsewhere in the CLI's own vocabulary.
 */
export const CLAUDE_TASK_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'stopped',
  'killed',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'timeout',
]);

// ── Messages ──────────────────────────────────────────────────────────────

/** Fallback for an error `result` line that carries no text of its own. */
export const CLAUDE_RUN_FAILED_MESSAGE = 'claude run failed';

/** What the CLI is told when the user denies a permission request. */
export const CLAUDE_DENY_MESSAGE = 'Denied by the user in Geniro';

/**
 * How the CLI reports that its own permission channel died under it.
 *
 * The failing tool comes back with `Tool permission request failed:
 * AbortError: Stream closed` as its RESULT TEXT — an ordinary tool result, not
 * an error line — which is why nothing in the daemon reacted to it and why 239
 * of them accumulated unremarked in one database.
 *
 * BOTH halves must be present, and only the stable halves are named: the
 * middle varies (the CLI's own issue tracker carries `Error: Stream closed`
 * beside `AbortError: Stream closed`), while the prefix and the closed stream
 * do not. Matching claude's own wording rather than anything stream-shaped is
 * why this is a marker in claude's constants and not a regex somewhere generic.
 */
export const CLAUDE_PERMISSION_CHANNEL_FAILURE_MARKERS: readonly string[] = [
  'Tool permission request failed',
  'Stream closed',
];

/** The `system` item a user sees when the channel above has dropped. */
export const CLAUDE_PERMISSION_CHANNEL_FAILURE_NOTICE =
  'claude could not reach its permission channel for that tool call, so the CLI refused it — this was not your decision, and the turn continues.';

// ── The agent's OWN task list (the todo tools) ─────────────────────────────
//
// NOT the background-task subtypes above: those name units of WORK the CLI runs
// (`CLAUDE_TASK_STARTED_SUBTYPE` and friends, which keep a turn open while a
// delegate runs). These are the tools the model calls to keep a checklist for
// itself while it works through a multi-step job — the thing every coding UI
// shows in a panel and geniro showed as an opaque `TaskUpdate` tool row.
//
// MEASURED on the wire, 2026-08-14, claude 2.1.232, one `-p
// --output-format stream-json` turn told to build a three-item list and move two
// of them. What arrived, in order:
//
//   TaskCreate   input  {subject:"Read the file", description:"Read the file",
//                        activeForm:"Reading the file"}
//                result "Task #1 created successfully: Read the file"
//   TaskUpdate   input  {taskId:"1", status:"completed"}
//                result "Updated task #1 status"
//   TaskList     input  {}
//                result "#1 [completed] Read the file\n#2 [in_progress] Edit the
//                        file\n#3 [pending] Run the tests"
//
// The id therefore lives in the RESULT of a create and in the INPUT of an
// update, which is what shapes `claude-tasks.utils.ts`: half of this is read off
// tool results, and that is not a stylistic choice.
//
// What is NOT available, checked so the next reader need not re-check: there is
// no pull channel for the list. The control-request subtypes of the 2.1.232
// binary were enumerated (the same method that found `mcp_status`), and the two
// task-shaped ones answer other questions — `background_tasks` takes a
// `tool_use_id` and replies `{backgrounded}`, `get_plan` returns the plan-mode
// markdown file. There IS a push channel, `system/background_tasks_changed`,
// carrying the full list — but it is emitted onto the CLI's remote-control
// bridge, and the probe above (which created and updated five tasks) produced no
// such line on stdout. So the tool calls are the whole source.
//
// One consequence, measured through the app on the same version: a SUB-AGENT
// keeps no list here. Told explicitly to build one, a delegate searched its own
// toolset three times (`select:TaskCreate,TaskUpdate`, then `select:TodoWrite,…`),
// found nothing, and did the work untracked — the task tools are not part of what
// this CLI hands a delegate. Nothing in the mapping is conditional on that: an
// announcement carries whatever origin the line it arrived on carried, so a
// delegate that DOES keep a list has it attributed to itself (pinned in
// `claude-tasks.utils.spec.ts`, and the renderer routes it in
// `transcript-groups.spec.ts`). It is written down because it leaves that path
// unproven on the wire for this CLI — re-check this, not the code, if a
// delegate's list ever fails to appear.

/**
 * `TaskUpdate` — `{taskId, status}`, the one call that MOVES a task, and the
 * only one of the family named here.
 *
 * `TaskCreate` and `TaskList` are recognised by their results instead, so their
 * names have no reader: a claude `tool_result` block carries `tool_use_id` and
 * no tool name, which is why the two regexes below exist at all.
 */
export const CLAUDE_TASK_UPDATE_TOOL = 'TaskUpdate';

/**
 * `TodoWrite` — the older single-call form, whose input IS the whole list.
 *
 * Mapped because it is still a live tool in 2.1.232 (present in the binary's own
 * tool allowlists beside the `Task*` family, with a `todo_reminder` mechanism
 * keyed on its name), and which of the two families a session is offered is not
 * ours to decide — this machine's 2.1.232 `system/init` listed
 * `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` and no `TodoWrite`, on a
 * different account from the one the app runs by default.
 *
 * Its payload shape here is the tool's PUBLISHED schema, not a wire capture:
 * nothing on this machine could be made to call it. That asymmetry is why it is
 * mapped defensively like every other version-volatile payload — a shape that
 * has drifted yields no tasks, never a wrong list — and why the reason is
 * written down instead of the code implying it was seen.
 */
export const CLAUDE_TODO_WRITE_TOOL = 'TodoWrite';

/**
 * A `TaskCreate` result: `Task #1 created successfully: Read the file`.
 *
 * Anchored at both ends because it is matched against the whole result text of
 * a tool call whose NAME is not on the wire — a claude `tool_result` block
 * carries `tool_use_id` and no name — so the sentence is the only thing that
 * identifies it. An unanchored search would let a `Bash` call that printed this
 * line inject a task.
 */
export const CLAUDE_TASK_CREATED_RESULT =
  /^Task #(\d+) created successfully: (.+)$/;

/** One `TaskList` row: `#2 [in_progress] Edit the file`. @see CLAUDE_TASK_CREATED_RESULT */
export const CLAUDE_TASK_LIST_ROW = /^#(\d+) \[([a-z_]+)\] (.+)$/;

// ── What the window currently HOLDS ─────────────────────────────────────────
//
// The second undocumented control request this adapter drives, found the same
// way as `mcp_status` — by enumerating the shipped binary's subtypes — and then
// probed live on 2.1.232. The CLI's own description of it, lifted from the
// bundle's SDK types, is "Requests a breakdown of current context window usage
// by category": it is the wire behind that CLI's own `/context` screen.
//
//     --> {"type":"control_request","request_id":"…",
//          "request":{"subtype":"get_context_usage"}}
//     <-- {"type":"control_response","response":{"subtype":"success",
//          "request_id":"…","response":{
//            "categories":[{"name":"System prompt","tokens":3386,…},
//                          {"name":"Memory files","tokens":59058,…},
//                          {"name":"MCP tools (deferred)","tokens":273876,
//                           "isDeferred":true,…},
//                          {"name":"Free space","tokens":901402,…}],
//            "totalTokens":98598,"maxTokens":1000000,"model":"claude-opus-5[1m]",
//            "memoryFiles":[{"path":"…/CLAUDE.md","type":"Project","tokens":45947}],
//            "mcpTools":[{"name":"mcp__x__y","serverName":"x","tokens":730,
//                         "isLoaded":false}, …371 rows],
//            "autoCompactThreshold":967000,"isAutoCompactEnabled":true,
//            "skills":{…},"agents":[…],"slashCommands":{…},
//            "messageBreakdown":{…},"apiUsage":{…},"gridRows":[…]}}}
//
// Three measured facts the projection depends on, each of which would be a
// defect to guess at:
//
//  - `isDeferred` rows are OUTSIDE `totalTokens`. Verified by arithmetic on a
//    live reading: the non-deferred, non-free rows sum to exactly 98598, and
//    `Free space` is `maxTokens - totalTokens`. Rendering the deferred MCP row
//    in the same bar would have reported a window nearly four times fuller than
//    it was.
//  - It is answerable at ANY point on the stdin dialogue — before the first
//    prompt, mid-turn, and between turns — which is what lets the readout be a
//    live question rather than a per-turn snapshot.
//  - It is NOT instant, and the reply is large. Measured at 1.2s cold, 1.3s
//    mid-turn, and 2.2s/3.3s for two asked back to back (the CLI serialises
//    them); the reply ran 41–84KB, nearly all of it `gridRows` (TUI squares)
//    and 371 per-tool rows. Both numbers are why this is asked ON DEMAND and
//    never on the turn's critical path, and why the projection drops those two
//    fields at the adapter instead of sending them to a renderer that would
//    hide them.
//
// Same expiry warning as the `mcp_status` block above: an observation of one
// build, not a contract. A renamed subtype or a reshaped reply degrades to "no
// breakdown", which is exactly what a CLI without the channel already shows.

/** The control subtype that reports the context window's category breakdown. */
export const CLAUDE_CONTEXT_USAGE_SUBTYPE = 'get_context_usage';

/**
 * How long one breakdown question waits for its answer.
 *
 * Well clear of the 1.2–3.3s measured above, because the cost of waiting is a
 * readout that opens a moment later while the cost of giving up early is a
 * panel that says the CLI cannot answer when it was about to. Nothing is
 * blocked behind it — no turn, no user input — so the ceiling only needs to be
 * short enough that a CLI which will never answer stops being waited for.
 */
export const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 8_000;

// ── The account's plan limits (probe block) ─────────────────────────────────
//
// `get_usage` is the THIRD undocumented control request this adapter drives,
// found the same way as `mcp_status` and `get_context_usage` — by enumerating
// the shipped binary's control subtypes — and probed live on 2.1.234 before
// any prompt had been written, which is what makes it answerable at all here.
//
// Finding the name was not enough, and the binary says so: it also carries
// "get_usage is not supported in this context (onGetUsage callback not
// registered)", so appearing in the subtype list proves only that the name
// exists. The measurement is that a headless `-p --output-format stream-json
// --input-format stream-json` process answered it in under a second, on the
// same stdin dialogue the other two ride.
//
// The reply (trimmed to what is projected):
//
//   {"subscription_type":"max","rate_limits_available":true,
//    "rate_limits":{
//      "five_hour":{"utilization":43,"resets_at":"2026-08-18T11:00:00+00:00",…},
//      "seven_day":{"utilization":30,"resets_at":"2026-08-23T11:00:00+00:00",…},
//      "seven_day_opus":null,"seven_day_sonnet":null, …,
//      "limits":[{"kind":"session","group":"session","percent":43,
//                 "severity":"normal","resets_at":"…","scope":null,
//                 "is_active":true},
//                {"kind":"weekly_all","group":"weekly","percent":30,…},
//                {"kind":"weekly_scoped","group":"weekly","percent":0,
//                 "scope":{"model":{"display_name":"Fable"}},…}]},
//    "session":{…},"behaviors":{"day":{…},"week":{…}}}
//
// Three decisions the projection rests on:
//
//  - `limits[]` is read, NOT the named `five_hour`/`seven_day` map beside it.
//    It is the list the CLI's own `/usage` dialog renders, so it already
//    carries only the windows that apply to this account, in that CLI's order,
//    and a model-scoped row brings its own `display_name` — which the named map
//    cannot supply. The map's keys would also have to be labelled here, in this
//    app's words, for windows the vendor is free to add.
//  - A row whose `kind` is not one this adapter can NAME is dropped rather than
//    labelled from its key. `weekly_scoped` is not a phrase to show anyone, and
//    a wrong label on a limit is worse than one row fewer: the two rows that
//    matter are always present, and a vendor's new window simply does not
//    appear until it is read here on purpose.
//  - `behaviors` (a local-transcript attribution scan the CLI itself marks
//    "Approximate, excludes other devices") and `session` (this process's own
//    cost, which the thread totals already report from durable rows) are both
//    dropped. Neither is what "when am I cut off" asks.
//
// Same expiry warning as the two blocks above: an observation of one build, not
// a contract. A renamed subtype or a reshaped reply degrades to "no reading",
// which is exactly what a CLI without the channel already shows.

/** The control subtype that reports the account's plan rate-limit windows. */
export const CLAUDE_PLAN_LIMITS_SUBTYPE = 'get_usage';

/**
 * How long one plan-limits question waits for its answer.
 *
 * The same ceiling as its context sibling, and for the same reasoning — the
 * measured reply was far quicker (under a second, against 1.2–3.3s there),
 * but the two are asked together on one open of the readout, so a tighter
 * bound here would only ever give up on a CLI the other is still waiting for.
 */
export const CLAUDE_PLAN_LIMITS_TIMEOUT_MS = 8_000;
