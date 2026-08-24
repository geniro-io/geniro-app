// ── `cursor-agent acp` ────────────────────────────────────────────────────

/**
 * Argv for the ACP server. Named because two callers now spell it: the turn
 * path's `buildArgs`, and the model listing, which spawns the same server for
 * a handshake and nothing else.
 */
export const CURSOR_ACP_ARGS: readonly string[] = ['acp'];

/** `clientInfo.name` this client introduces itself with over ACP. */
export const CURSOR_ACP_CLIENT_NAME = 'geniro';

// ── The parameterized model picker ────────────────────────────────────────
//
// WHERE THIS CAME FROM. Read out of the CLI's own bundled source, not any
// published doc — `~/.local/share/cursor-agent/versions/<v>/2996.index.js` on
// 2026.08.11-e8db854:
//
//   clientSupportsParameterizedModelPicker() {
//     return true === this.clientCapabilities?._meta?.parameterizedModelPicker;
//   }
//   getModelPickerMode() {
//     return this.clientSupportsParameterizedModelPicker()
//       ? "parameterized" : "variants";
//   }
//
// Without the flag the agent runs in `variants` mode: it composes ONE opaque id
// per model family out of that family's stored parameters
// (`claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`) and
// accepts only those — which is why "I cannot change the effort of a Cursor
// model" was true, and why it was mis-recorded here as a property of the CLI
// rather than of the handshake geniro happened to send.
//
// With it, `session/new` returns the model as a BARE name plus one config
// option per parameter, each carrying its own vocabulary. Measured on the same
// build, with the account's own models:
//
//   model    [model]         claude-opus-5, claude-sonnet-5, … (33 bare names)
//   effort   [thought_level] low, medium, high, xhigh, max
//   thinking [thought_level] false, true
//   context  [model_config]  300k, 1m
//   fast     [model_config]  false, true
//
//   model=claude-opus-5 -> ACCEPTED, and its parameters appear with defaults
//   effort=xhigh        -> ACCEPTED   (rejected in variants mode)
//   effort=max          -> ACCEPTED
//   effort=bogus        -> -32602     (so the vocabulary is authoritative)
//
// ORDER IS LOAD-BEARING. `buildModelParameterConfigOptions` derives the options
// from the CURRENT model, and a fresh profile opens on `auto-smart`, which has
// no parameters at all — so setting `effort` before `model` is
// `-32602 Unknown model config option: effort`. Model first, then parameters.

/**
 * The `clientCapabilities._meta` this client declares, which is what unlocks the
 * separate effort control. A vendor extension, so it lives here and is injected
 * into the agent-agnostic driver rather than spelled inside it.
 */
export const CURSOR_ACP_CLIENT_META: Readonly<Record<string, unknown>> = {
  parameterizedModelPicker: true,
};

/**
 * The parameter whose values ARE the reasoning-effort vocabulary — every
 * spelling of it, weakest-known first.
 *
 * ONE axis, two names, and which one a model uses is the MODEL's business:
 * probed 2026-08-19 on 2026.08.11-e8db854, `claude-opus-5` and `grok-4.6`
 * enumerate `thought_level/effort` while `gpt-5.2` enumerates
 * `thought_level/reasoning` (`low|medium|high|extra-high`). Sending the wrong
 * one is `-32602 Unknown model config option`, which is why the OpenAI-family
 * models had no working effort control at all until this became a list.
 *
 * `cursorModelEffort` has read both spellings out of a legacy composed id since
 * that id existed; this is the same fact on the WRITE side, which is where it
 * was missing. Named rather than inline because three readers now spell it —
 * the listing, the selection builder and the driver's alias resolution.
 */
export const CURSOR_EFFORT_PARAMETER_IDS = ['effort', 'reasoning'] as const;

/**
 * The spelling geniro SENDS when it has nothing better to go on.
 *
 * The first of {@link CURSOR_EFFORT_PARAMETER_IDS}, because it is the one every
 * model but the OpenAI family uses. It is only ever the fallback: where the
 * session reply describes the turn's model, the driver picks whichever spelling
 * that model actually offers.
 */
export const CURSOR_EFFORT_PARAMETER_ID = CURSOR_EFFORT_PARAMETER_IDS[0];

/**
 * The parameter that selects which CONTEXT WINDOW a model runs at.
 *
 * ONE spelling, unlike the effort axis, and that is a measurement rather than
 * an assumption: swept across all 34 models on 2026-08-21 (2026.08.11-e8db854),
 * every model that offers the axis at all spells it `context` under the
 * category `model_config` — the twelve that do differ in their VALUES
 * (`300k|1m`, `272k|1m`, `200k|1m`) and not in the key. Re-check by re-running
 * that sweep; a second spelling appearing turns this into a list, exactly as
 * {@link CURSOR_EFFORT_PARAMETER_IDS} already is.
 *
 * Named rather than inline because three readers spell it: the listing probe,
 * the turn's selection builder, and the driver that sends it.
 */
export const CURSOR_CONTEXT_WINDOW_PARAMETER_ID = 'context';

// ── The per-turn config directory ─────────────────────────────────────────
//
// Applying a model or an effort over ACP PERSISTS into the config directory, so
// a turn gets its own; see `utils/cursor-profile.utils.ts` for the measurements
// behind every part of this (including why `mcp.json` is not copied, and why the
// conversation store is the one thing linked OUT of the throwaway directory).

/** Where the per-turn profiles live, under the daemon's userData dir. */
export const CURSOR_PROFILE_DIR_NAME = 'cursor-profiles';
/** `mkdtemp` prefix inside it, so two concurrent turns cannot share one. */
export const CURSOR_PROFILE_DIR_PREFIX = 'turn-';
/** The user's own CLI config directory, relative to their home. */
export const CURSOR_HOME_DIR_NAME = '.cursor';
/** The one file copied in, so the turn keeps the user's own settings. */
export const CURSOR_SEEDED_CONFIG_FILE = 'cli-config.json';
/** The env var the CLI resolves its config directory from. */
export const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';
/**
 * Where the CLI keeps each ACP conversation, RELATIVE TO ITS CONFIG DIRECTORY —
 * `acp-sessions/<sessionId>/{meta.json,store.db}`.
 *
 * This is the one thing in a config directory that must NOT be per turn, and
 * missing that shipped a chat whose every message after the first failed: the
 * conversation `session/load` resumes lives here, so a profile removed on settle
 * takes the thread with it. Probed on 2026.08.11-e8db854 — `session/load` under
 * a second, empty profile answers
 * `-32602 Invalid params {"message":"Session \"…\" not found"}` and the turn dies
 * there, while the same load under the profile that created it succeeds.
 *
 * So the turn profile links this name at a store shared by every turn
 * ({@link CURSOR_SESSION_STORE_DIR_NAME}), and the settings the isolation exists
 * for stay per turn. Written by `utils/cursor-profile.utils.ts`; hardcoded in the
 * CLI's own bundle (`join(cursorHome, "acp-sessions")`, `2996.index.js`), so
 * there is no flag that would move it.
 */
export const CURSOR_ACP_SESSIONS_DIR_NAME = 'acp-sessions';
/**
 * Where those conversations actually live, under the daemon's userData dir.
 *
 * Deliberately NOT inside {@link CURSOR_PROFILE_DIR_NAME}: the boot sweep
 * removes that base wholesale, which would delete every thread on every launch.
 */
export const CURSOR_SESSION_STORE_DIR_NAME = 'cursor-sessions';

/**
 * Deadline for the model handshake.
 *
 * Far below the MCP listing's 20s because nothing is dialled: the probe writes
 * two frames and reads one reply, which took under a second against
 * 2026.08.04-aaa8809. What it must still absorb is a cold CLI start and an
 * auth check. The read cannot end on its own — `cursor-agent acp` does NOT
 * exit when its stdin closes (probed on the same build) — so this deadline is
 * the only backstop behind `acpModelProbeSettled`, and a listing that reached
 * it reports an unknown vocabulary rather than an empty one.
 *
 * 15s is HEADROOM over a measured cold read, not an expectation. Measured
 * end-to-end through `GET /v1/agents/models` on 2026.08.04-aaa8809: **7.0s
 * cold** (a fresh daemon, so the `--version` probe and the CLI's own start and
 * auth check are all in it), **0.009s warm**. An earlier revision cut this to
 * 8s to bound the wait and was wrong to: at ~1s of margin over the observed
 * cold path, a slower machine or a slower auth check turns a listing that works
 * into an empty picker, and "no models" is indistinguishable from "this account
 * has none".
 *
 * What actually bounds the user-visible cost is the cache and the
 * single-flight, not this number: 7s is paid once per CLI version per 10-minute
 * TTL, and concurrent asks join one probe instead of spawning their own. Still
 * under the renderer's own 30s request budget, so even the worst case surfaces
 * as "default model only" rather than as a transport error.
 */
export const CURSOR_MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long `session/list` gets. Shorter than the model probe's budget because
 * it is a strictly smaller question — `initialize` then one lookup, with no
 * `session/new` in between — and because it is asked interactively, when the
 * user opens the picker, where a stall is felt rather than merely logged.
 */
export const CURSOR_SESSION_LIST_TIMEOUT_MS = 12_000;

/**
 * How long a `session/load` gets to replay a conversation. Longer than the
 * listing's: the handshake is the same, but the agent then streams the entire
 * prior transcript before it answers, and a long thread is a lot of frames.
 */
export const CURSOR_SESSION_LOAD_TIMEOUT_MS = 30_000;

/**
 * Refusal when the conversation being imported is not in the profile it was
 * listed under — a session removed, or an id from another profile. Said as the
 * user's own problem, not as a path, because the path is inside a store they
 * did not choose the layout of.
 */
export const CURSOR_SESSION_MISSING_MESSAGE =
  'that cursor-agent session is no longer in this profile — it may have been deleted since the list was taken';

// ── `cursor-agent mcp list` ───────────────────────────────────────────────
//
// This adapter deliberately carried NO const file until now: every static fact
// about the CLI was a value only `getConfig()` read, so it belonged inline
// beside the field it answered. The listing is the first thing here that is
// NOT such a fact — it spans two files, the adapter and its parser, so these
// strings cross a file boundary and have nowhere inline to live. (Each export
// below has exactly one production reader today; what disqualifies the inline
// exception is that the reader is not `getConfig()`.)
//
// Everything below was captured from the real binary, version
// `2026.07.23-e383d2b`, and the verbatim output is kept alongside the
// milestone that added it. The CLI has no machine-readable mode for this
// listing — `mcp list` takes no options at all — so this reads its prose and
// is version-volatile by construction.

/** Argv for the folder-scoped server listing. */
export const CURSOR_MCP_LIST_ARGS: readonly string[] = ['mcp', 'list'];

/**
 * Deadline for that listing. Same budget claude's gets, and for the same
 * reason: the command HEALTH-CHECKS, dialling every configured server, so an
 * unreachable HTTP one costs its own connect timeout before the CLI answers.
 *
 * Three configured servers (two unreachable) took 3.4s when probed, so this is
 * headroom rather than an expectation. Bounded ABOVE by the renderer's own 30s
 * per-request budget (`daemon-api.ts` REQUEST_TIMEOUT_MS) — at 30s here the
 * client would always abort first and the daemon's "could not read" sentence
 * would never reach the panel.
 */
export const CURSOR_MCP_LIST_TIMEOUT_MS = 20_000;

/**
 * Row status markers — the whole vocabulary the CLI printed.
 *
 * A row is `<name>: <status>` and nothing else. Unlike claude, cursor prints no
 * command column and no transport, so there is no structural delimiter inside a
 * row: recognising the status IS the only way to tell a row from a line of
 * prose. That is why these three strings carry more weight here than their
 * claude counterparts do, and why an unrecognised status costs the whole
 * listing rather than one badge — see `parseCursorMcpList`.
 *
 * `Error:` keeps its colon: the reason follows it (`Error: Connection failed`),
 * and both a missing stdio binary and an unreachable HTTP URL produced that
 * identical wording, so the reason is coarse but it is all the CLI gives.
 */
export const CURSOR_MCP_READY_MARKER = 'ready';
export const CURSOR_MCP_FAILED_MARKER = 'Error:';
export const CURSOR_MCP_PENDING_MARKER = 'not loaded';

/**
 * What a server switched off with `cursor-agent mcp disable <name>` reports.
 *
 * Captured from the same binary:
 *
 * ```
 * $ cursor-agent mcp disable probe-http
 * ✓ Disabled MCP server: probe-http
 * $ cursor-agent mcp list
 * probe-good: ready
 * probe-broken: Error: Connection failed
 * probe-http: disabled
 * ```
 *
 * Reachable by the mechanism {@link CURSOR_MCP_DISABLE_ARGS} drives, which
 * geniro's own switch now writes — so it is a routine state, not an exotic one,
 * and it is what makes the switch POSITION readable without geniro having to
 * locate the CLI's state file: `AgentMcpService.composeListing` already reads a
 * row the CLI itself calls disabled as disabled.
 */
export const CURSOR_MCP_DISABLED_MARKER = 'disabled';

/**
 * What a server the user has not authenticated to reports.
 *
 * OBSERVED on 2026.08.11 against 2026.08.04-aaa8809, on a machine whose
 * `~/.cursor/mcp.json` configures eleven servers:
 *
 * ```
 * $ cursor-agent mcp list
 * playwright: ready
 * linear: requires_authentication
 * github: ready
 * vercel: requires_authentication
 * ```
 *
 * This is the wording the adapter's `mcp.loginArgs` block said it was waiting
 * for. Until it was seen, no marker was invented for it — the note there
 * records why — so the rows it covers parsed as `unknown` and rendered a badge
 * with nothing to do about it. They are the majority of a real listing (eight
 * of the eleven above), and `needs_auth` is the status the panel already draws
 * a sign-in control for, which `cursor-agent mcp login <name>` can act on.
 */
export const CURSOR_MCP_NEEDS_AUTH_MARKER = 'requires_authentication';

/**
 * Printed INSTEAD of any rows when neither `.cursor/mcp.json` nor
 * `~/.cursor/mcp.json` configures a server.
 *
 * It is the only thing that tells an empty folder apart from output the parser
 * could not read at all. Kept to the stable opening words and matched as a
 * SUBSTRING, because the CLI appends the two paths it looked in — the kind of
 * detail a release rewords.
 */
export const CURSOR_MCP_EMPTY_MARKER = 'No MCP servers configured';

/**
 * Argv for the two halves of the switch.
 *
 * WHERE THE PER-FOLDER CLAIM COMES FROM. This adapter used to declare the
 * toggle unavailable, on the recorded grounds that `mcp enable|disable` "write
 * the user's global `~/.cursor/cli-config.json`" and take effect "in EVERY
 * folder". Both halves of that are wrong on 2026.08.11-e8db854, and the CLI's
 * own bundled source says where it really goes
 * (`~/.local/share/cursor-agent/versions/<v>/index.js`):
 *
 *   "./src/mcp/project-paths.ts": function o(dir) {
 *     return join(dir, "mcp-disabled.json")
 *   }
 *   function C(cwd, root) {
 *     const projectRoot = root ?? gitRoot(cwd) ?? cwd;
 *     const projectDir  = cursorConfig.projectDir(projectRoot);
 *     return { cwd, projectRoot, projectDir,
 *              approvalPath: join(projectDir, "mcp-approvals.json"),
 *              disabledPath: o(projectDir) };
 *   }
 *
 * and `./src/commands/disable.ts` reads `process.cwd()` and writes through
 * that `disabledPath`. Measured against the real binary, and BOTH directions
 * of the old claim fell:
 *
 * - not `cli-config.json` — its md5 was byte-identical across a `disable`, and
 *   no file under `~/.cursor` changed at all except
 *   `~/.cursor/projects/<key>/mcp-disabled.json`, which appeared holding
 *   `["playwright"]`;
 * - not global — `disable codegraph` run in an unrelated directory wrote that
 *   directory's own project key and left `codegraph: ready` in this repo.
 *
 * So the grain is the same one claude's `projects[<cwd>].disabledMcpServers`
 * has, and geniro switches it the way the CLI's OWN toggle does: the TUI's
 * handler (`6260.index.js`) is `addApproval` then `removeDisabledServer` on
 * enable, `addDisabledServer` on disable — which is why enable goes through
 * `mcp enable` rather than merely un-disabling. It also approves, and that is
 * the CLI's own definition of the switch being on.
 *
 * Deliberately NOT reimplemented as a file write, unlike claude's: the path
 * above needs the git root, `CURSOR_DATA_DIR`/`XDG_CONFIG_HOME`, and the right
 * one of the CLI's two project-dir functions — the other bounds the length and
 * falls back to a sha256 of the path past 92 characters. Driving the
 * subcommand leaves all of that where it belongs.
 *
 * WHY THE OLD MEASUREMENT WENT WRONG is worth writing down, because it is the
 * cheap mistake: `projectRoot` is `gitRoot(cwd) ?? cwd`, so two folders inside
 * one repository DO share a single disabled list. "Every folder" is what
 * per-repository looks like if the folders you compare are both in the same
 * repository.
 *
 * RE-CHECK IF: `mcp --help` loses either subcommand, or a `disable` in one
 * repository starts showing up in another.
 */
export const CURSOR_MCP_ENABLE_ARGS: readonly string[] = ['mcp', 'enable'];
export const CURSOR_MCP_DISABLE_ARGS: readonly string[] = ['mcp', 'disable'];

/**
 * Argv for the ONE-server health probe, and the wording it answers with.
 *
 * `cursor-agent mcp list-tools <name>` — "List available tools and their
 * argument names for a specific MCP", from the CLI's own `mcp --help`. It dials
 * that server and nothing else, which is what makes it usable where the folder
 * listing is not: measured on 2026.08.11-e8db854 against this machine's eleven
 * servers, one server takes 1.2–3.7s where the whole folder takes 4–9s.
 *
 * Captured verbatim, and note that only the first is on stdout with exit 0 —
 * the other two exit 1 and write to STDERR, which is why the caller sets
 * `captureDiagnosis`:
 *
 * ```
 * $ cursor-agent mcp list-tools codegraph          # exit 0
 * Tools for codegraph (1):
 * - codegraph_explore (query, maxFiles, projectPath)
 *
 * $ cursor-agent mcp list-tools figma              # exit 1, stderr
 * MCP 'figma' requires authentication.
 * Please run: agent mcp login figma
 *
 * $ cursor-agent mcp list-tools vercel             # exit 1, stderr
 * Failed to list tools: Failed to load MCP 'vercel': Streamable HTTP error: …
 * ```
 *
 * The failed marker also covers a name in no config at all
 * (`Failed to load MCP 'x': MCP client "x" not found in config`), which is the
 * right reading: the panel only ever asks about a server its own listing named,
 * so that answer means the config changed underneath — a real failure, not a
 * state to invent a badge for.
 *
 * The ready marker keeps its trailing space-and-paren shape out of it on
 * purpose: the count varies, and `Tools for ` is the stable part.
 *
 * RE-CHECK IF: `list-tools` leaves `mcp --help`, or a probe starts reporting a
 * server as broken that the folder listing calls fine — the first sign of a
 * reworded message.
 */
export const CURSOR_MCP_TOOLS_ARGS: readonly string[] = ['mcp', 'list-tools'];
export const CURSOR_MCP_TOOLS_READY_MARKER = 'Tools for ';
export const CURSOR_MCP_TOOLS_AUTH_MARKER = 'requires authentication';
export const CURSOR_MCP_TOOLS_FAILED_MARKER = 'Failed to list tools';

/**
 * Deadline for that probe. One server rather than a folder, so it is bounded by
 * one connect timeout instead of the slowest of eleven — but a dead HTTP
 * endpoint still gets to spend its own, so this stays generous. Under the
 * listing's budget, since this is the cheaper question.
 */
export const CURSOR_MCP_TOOLS_TIMEOUT_MS = 15_000;

/**
 * Shown when the switch command itself failed.
 *
 * Only `enable` can reach it. Measured on the same build: `mcp enable` on a
 * name that is in no config exits 1 with "not found in configuration", while
 * `mcp disable` exits 0 and writes the name anyway — it validates nothing. So
 * the off direction cannot refuse, and this sentence is about turning one ON.
 */
export const CURSOR_MCP_TOGGLE_FAILED_MESSAGE =
  'cursor-agent refused to switch that server — it may no longer be in .cursor/mcp.json or ~/.cursor/mcp.json';

/**
 * Why a cursor row's switch is never locked OFF the way a claude row's can be.
 *
 * claude unions a `.mcp.json` REJECTION list out of several settings files, and
 * a name in any of them is one geniro cannot pull back out — that is what its
 * `userDisabledReason` explains. No equivalent has been found for this CLI:
 * `mcp-disabled.json` is the only state its own switch writes, and `mcp enable`
 * undoes it. So `readMcpFolderFacts` reports an empty `lockedOff` and this
 * sentence is unreachable today; it exists because the contract wants a string,
 * and it says what it would mean if one were ever found.
 */
export const CURSOR_MCP_USER_DISABLED_REASON =
  'switched off in cursor-agent’s own configuration, which geniro cannot undo';

/**
 * Shown to the user when the listing command could not be run at all — a
 * missing binary, a non-zero exit, or the deadline. Deliberately distinct from
 * an empty listing: only one of the two is a fact about their configuration.
 */
export const CURSOR_MCP_LIST_FAILED_MESSAGE =
  'could not read MCP servers — cursor-agent did not answer';

/** Shown when the CLI answered but nothing in its output looked like a row. */
export const CURSOR_MCP_LIST_UNREADABLE_MESSAGE =
  'could not read MCP servers — the cursor-agent output format may have changed';

// ── Asking the user a question (`cursor/ask_question`) ────────────────────
//
// WHERE THIS SHAPE CAME FROM. Baseline ACP has no agent→client call for
// asking the user something open-ended — permissions are the only round-trip
// it defines — so Cursor added one as a vendor extension.
//
// Read out of the CLI'S OWN SOURCE, not its docs. cursor-agent ships as plain
// bundled JavaScript, and its handler is legible:
//
//   ~/.local/share/cursor-agent/versions/<v>/8869.index.js
//   → "./src/acp/interaction-handlers/ask-question-handler.ts"
//
// on 2026.08.04-aaa8809, which is where the request fields
// (`toolCallId`/`title`/`questions[].id`/`prompt`/`options[].id`/`label`/
// `allowMultiple`) and the three response outcomes below are transcribed
// from. That is a stronger source than the published docs AND than a wire
// capture: it is what the binary will actually send and accept. It still
// expires — a release can rewrite it — so re-read that handler rather than
// trusting this block on a new cursor series.
//
// It has NOT been seen on the wire. Driving 2026.08.04 into asking a
// multiple-choice question (directly, and through its own
// `/multi-model-review` command, which advertises "structured question or
// inline") produced plain markdown in an `agent_message_chunk` both times.
// So the readers below stay defensive and the driver keeps its `accepts()`
// gate: an unparseable payload is declined exactly as before.
//
// WHAT DECLINING ACTUALLY COST, measured rather than assumed. The same
// handler catches an Unimplemented/-32601 reply and FALLS BACK to one
// `session/request_permission` per single-select question, each option
// becoming an `allow_once` option beside a synthetic `__ask_question_skip__`
// rejection. So the old behaviour did not stall the turn — it was worse than
// that. Replayed against the pre-fix build: geniro rendered a generic
// permission card titled with the ask's `title` and NO arguments, whose
// Approve picks the FIRST allow_once option; and under `auto` the daemon
// auto-approved it, answering the user's question with option #1 and no
// human involved at all. The fallback also drops every `allowMultiple`
// question on the floor, which is why answering one is a capability of this
// channel specifically.

/** The vendor method carrying a question for the user. */
export const CURSOR_ASK_QUESTION_METHOD = 'cursor/ask_question';

/** `CursorAskQuestionResponse.outcome.outcome` — the arm we answer with. */
export const CURSOR_QUESTION_OUTCOME_ANSWERED = 'answered';
/** The arm for a question the user declined to answer, carrying a `reason`. */
export const CURSOR_QUESTION_OUTCOME_SKIPPED = 'skipped';

/**
 * Where {@link CursorAcpAdapter.withAnswer} stashes the card's free text on
 * the request params, for the reply encoder to read back.
 *
 * The seam it has to cross is `AgentAdapter.withAnswer` → `respondApproval` →
 * `TurnDriver.buildApprovalResponse`, which carries ONE opaque `updatedInput`
 * — a shape claude uses to fold an answer into a tool input and cursor has no
 * equivalent of. Both ends of this key are in this adapter, so no other layer
 * sees it; the `geniro` prefix is what keeps it from colliding with a field
 * the vendor might add.
 */
export const CURSOR_ANSWER_KEY = '__geniroAnswer';

/**
 * The vendor extensions this client refuses SILENTLY — declined in-protocol
 * like any other, but without spending the turn's single "declined" notice.
 *
 * Each entry is a reading of that method's own handler in the CLI source
 * (same file as {@link CURSOR_ASK_QUESTION_METHOD}), never an assumption:
 *
 * - `update_todos`, `task`, `generate_image` go out through
 *   `sendNonBlockingExtensionNotification`, which is
 *   `connection.extMethod(...).catch(debugLog)`. The agent discards the
 *   outcome entirely, so a refusal changes nothing about the turn. Wire-
 *   confirmed for `update_todos` on 2026.08.04-aaa8809: an ordinary "make a
 *   todo list" turn sends it and then completes normally after a `-32601`.
 * - `create_plan` DOES block, but its handler treats Unimplemented as a cue to
 *   write the plan locally and report success. The work still happens; only
 *   the delivery differs.
 *
 * `ask_question` is deliberately ABSENT, and is the reason this list is not
 * simply "every `cursor/*`": its fallback answers the user's question with the
 * first option on their behalf. That is the shape of harm this list must never
 * cover — so an entry is earned by reading the handler, not by sharing a
 * prefix with one that was.
 *
 * `task` was here too, and its removal is a lesson about what this list COSTS.
 * Every word written above it was true — the agent does discard the outcome, a
 * refusal did change nothing about the turn — and being harmless to refuse is
 * not the same as being worthless to accept. It is the only thing on this
 * transport that says what a sub-agent was asked to do, and while it sat here
 * geniro declined it on every delegating turn and the adapter declared, one
 * file away, that this CLI reports no sub-agents at all. An entry earns its
 * place by its handler being harmless to refuse AND its payload carrying
 * nothing geniro wants; the second half is what was skipped.
 */
export const CURSOR_SILENTLY_DECLINED_METHODS: readonly string[] = [
  'cursor/generate_image',
  'cursor/create_plan',
];

// -- The agent's own task list (`cursor/update_todos`) ----------------------
//
// MEASURED on the wire, 2026-08-14, cursor-agent 2026.08.11-e8db854, against a
// throwaway CURSOR_CONFIG_DIR and a prompt asking for a tracked three-step job.
// Four announcements arrived, each preceded by its own tool call:
//
//   session/update  tool_call  {toolCallId:"toolu_vrtx_01BgZ...", title:"Update TODOs",
//                              kind:"other", rawInput:{_toolName:"updateTodos"}}
//   cursor/update_todos (a REQUEST, id 0)
//     {toolCallId:"toolu_vrtx_01BgZ...", merge:false,
//      todos:[{id:"1", content:"Read alpha.txt",  status:"in_progress"},
//             {id:"2", content:"Read beta.txt",   status:"pending"},
//             {id:"3", content:"Write summary.txt ...", status:"pending"}]}
//   ... then three more with merge:TRUE, each carrying only the rows that moved:
//     {toolCallId:"...", merge:true, todos:[{id:"1", status:"completed"},
//                                           {id:"2", status:"in_progress"}]}
//
// This is the second vendor extension found to be REAL after being declined for
// two milestones, and it was declined the quietest way: the method is on the
// silence list above, so nothing was even said about it. What the user saw was
// the `Update TODOs` tool row — which discloses no arguments at all
// (`rawInput:{_toolName:"updateTodos"}`), so the list existed nowhere in geniro.
//
// Baseline ACP's `plan`/`plan_update` session updates are NOT what this agent
// sends: across the whole probe not one arrived, and the driver's own default arm
// still lists them as updates the transcript does not model. If a future agent
// uses them, that is the place to add it — not here.

/** @see CURSOR_SILENTLY_DECLINED_METHODS for the frames this method carries. */
export const CURSOR_TODOS_METHOD = 'cursor/update_todos';

// ── Background sub-agents (the `task` tool) ────────────────────────────────
//
// MEASURED on the wire, 2026-08-13, cursor-agent 2026.08.11-e8db854, against a
// throwaway CURSOR_CONFIG_DIR and a prompt asking the agent to delegate. One
// delegation produced, in this order:
//
//   session/update  tool_call        {toolCallId:"toolu_018bc…", title:"Task: Subagent task",
//                                    kind:"other", status:"pending", rawInput:{_toolName:"task"}}
//   session/update  tool_call_update {toolCallId:"toolu_018bc…", status:"in_progress"}
//   session/update  tool_call_update {toolCallId:"toolu_018bc…", status:"completed",
//                                    rawOutput:{durationMs:13075, isBackground:false}}
//   cursor/task     (a REQUEST, id 0) {toolCallId:"toolu_018bc…",
//                                    description:"List files in directory",
//                                    prompt:"Your task is simple and self-contained: …",
//                                    subagentType:{custom:{unspecified:{}}},
//                                    model:"claude-opus-5-thinking-high",
//                                    agentId:"bce43ebb-…", durationMs:13075}
//
// Three things follow, and each is why one constant below exists:
//
// 1. The launch is recognisable ONLY by `rawInput._toolName` — the ACP frame
//    carries no machine tool name, and its title at that point is a placeholder
//    with the description not yet filled in.
// 2. Everything the CLI says about the delegate arrives at the END, on
//    `cursor/task`. So a block can open at launch but stays unlabelled until
//    then, which is why `subagent_info` is emitted twice and merged.
// 3. NOTHING the delegate itself did crosses the wire — no nested tool calls, no
//    second session, no `sessionId` but the parent's. Its transcript is written
//    under the CLI's own project dir (`kind:"subagent"`, `parentConversationId`;
//    `190.index.js` → `getSubagentTranscriptPathIfExists`), which is a private
//    blob store and deliberately not read here.
//
// A fourth thing follows from the `rawOutput` above, and it is why the adapter
// declares `resultIsBookkeeping`: `{durationMs, isBackground}` is the CLI's own
// accounting, not the delegate's report — the findings only ever appear in the
// MAIN agent's next message. The duration is kept (it rides `cursor/task`);
// `isBackground` is deliberately dropped, having been observed only as `false`.
//
// RE-CHECK IF: a release starts sending `rawInput` with the args populated on the
// opening frame (then the marker can give way to reading them directly); a
// `session/update` variant appears that carries a parent/sub-session id (then the
// delegate's own steps become streamable and
// `CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON` must go); or `isBackground: true` is
// ever seen, which would be a delegate still running past the turn and the one
// state this transcript could not currently express.

/** The vendor method announcing one background sub-agent, with its brief. */
export const CURSOR_TASK_METHOD = 'cursor/task';

/**
 * The `rawInput` entry marking a tool call as a delegation. Its key is the
 * machine tool name this CLI stamps on every call's arguments (`_toolName`),
 * which is the only name on the frame — the title is prose.
 */
export const CURSOR_TASK_LAUNCH_MARKER = { key: '_toolName', value: 'task' };

/**
 * `subagentType` values that name no type at all, so the row says nothing
 * rather than labelling a delegate `unspecified`.
 *
 * Both spellings observed: the enum's own zero value, and the `{custom:{…}}`
 * wrapper the oneof puts an unrecognised value in — which is what a plain
 * delegation with no declared type actually arrives as
 * (`subagentType:{custom:{unspecified:{}}}` above).
 */
export const CURSOR_SUBAGENT_TYPE_UNSPECIFIED: readonly string[] = [
  'unspecified',
  'default',
];

/** Why a cursor delegate's block opens onto no conversation. See §3 above. */
export const CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON =
  'cursor-agent reports the delegation but not the work inside it — the ' +
  'sub-agent runs as its own conversation and none of its steps reach this ' +
  'client, so there is nothing to show but what it was asked and what it took';

/**
 * The SQLite file the CLI keeps one conversation's state in, inside that
 * session's directory under the store — see
 * `utils/cursor-context-store.utils.ts` for what is in it and how it was
 * probed. Named here rather than inline because the adapter spells the path
 * and its spec spells it back.
 */
export const CURSOR_SESSION_STORE_DB_NAME = 'store.db';

/**
 * The flat JSON header beside that database, carrying the conversation's `cwd`
 * and the title the AGENT generated for it. Named here for the same reason its
 * neighbour is — the adapter spells the path and its spec spells it back.
 */
export const CURSOR_SESSION_META_NAME = 'meta.json';

// ---------------------------------------------------------------------------
// This CLI reporting its OWN failure — as an assistant message, under end_turn
// ---------------------------------------------------------------------------

/**
 * What every failure arm of this CLI's ACP layer opens its message chunk with.
 *
 * A LITERAL in the shipped bundle, not a wording: `2996.index.js` writes
 * `` `\n\nError: ${String(e)}` `` for the general case and a hardcoded
 * `"\n\nError: [unauthenticated] …"` for the auth one. Named here rather than
 * inline because `utils/cursor-agent-failure.utils.ts` matches it and that
 * file's spec spells it back — the two must not drift.
 */
export const CURSOR_AGENT_FAILURE_PREFIX = 'Error: ';

/**
 * The four names `String(e)` can put after that prefix — this CLI's own error
 * CLASSES, read off `index.js`, where each is a `get kind()` getter:
 * `class R extends B{get kind(){return"RetriableError"}}`, and the same shape
 * for the other three.
 *
 * A class name rather than a phrase is the whole reason this match is sound:
 * an agent writing about an error writes prose, not `RetriableError:` directly
 * after a chunk-opening `Error: `.
 */
export const CURSOR_AGENT_FAILURE_ERROR_KINDS: readonly string[] = [
  'RetriableError',
  'NonRetriableError',
  'ActionRequiredError',
  'CancelledError',
];

/**
 * The one failure arm that carries no class name — the CLI substitutes its own
 * sentence for a `connect` `Unauthenticated` code, so this is matched on the
 * bracketed code that opens it instead.
 */
export const CURSOR_AGENT_FAILURE_UNAUTHENTICATED = '[unauthenticated]';

/**
 * The four sentences an `ActionRequiredError` is REPLACED by — this arm drops
 * the class name entirely and sends the sentence alone, with no `Error: `
 * prefix, so these are the anchor.
 *
 * Read off the same catch block:
 *   {login:"Please sign in to continue", upgrade:"Upgrade your plan to continue",
 *    payment:"Add a payment method to continue", config:"Check your settings to continue"}
 *
 * The arm's own fallback for an action with no sentence (`e.message`) is
 * deliberately absent: it is unanchored text, and matching it would risk
 * putting the agent's own words in the failure chrome.
 */
export const CURSOR_AGENT_FAILURE_ACTION_SENTENCES: readonly string[] = [
  'Please sign in to continue',
  'Upgrade your plan to continue',
  'Add a payment method to continue',
  'Check your settings to continue',
];
