// ── `cursor-agent acp` ────────────────────────────────────────────────────

/**
 * Argv for the ACP server. Named because two callers now spell it: the turn
 * path's `buildArgs`, and the model listing, which spawns the same server for
 * a handshake and nothing else.
 */
export const CURSOR_ACP_ARGS: readonly string[] = ['acp'];

/** `clientInfo.name` this client introduces itself with over ACP. */
export const CURSOR_ACP_CLIENT_NAME = 'geniro';

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
 * Reachable by the ONLY mechanism this CLI offers for switching a server off —
 * the one {@link CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON} tells the user about —
 * so it is a routine state, not an exotic one.
 */
export const CURSOR_MCP_DISABLED_MARKER = 'disabled';

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
 * Why a cursor row never carries a switch.
 *
 * `cursor-agent mcp enable|disable` DO exist, but they write the user's global
 * `~/.cursor/cli-config.json`: enabling one server was observed to flip it from
 * `not loaded` to `ready` in EVERY folder, not just the one the command ran in.
 * There is no per-invocation equivalent — `--approve-mcps` was probed and does
 * not affect `mcp list` at all — so geniro has nothing it could switch without
 * editing a file this feature has ruled out touching.
 *
 * Named because `getConfig()` states it three times: `toggleUnavailableReason`
 * is the one a user can actually read, and the other two are unreachable while
 * it is non-null (`AgentMcpService` returns early on it before ever consulting
 * them) — they exist only to satisfy a contract that requires a string. Three
 * copies of one sentence to keep in lockstep is what a name is for.
 */
export const CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON =
  'cursor-agent can only switch MCP servers in its own global config';

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
