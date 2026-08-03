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
