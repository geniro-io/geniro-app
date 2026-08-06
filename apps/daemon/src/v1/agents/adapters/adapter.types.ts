import type { ChildProcess } from 'node:child_process';

import type { AgentKind } from '../../runs/runs.types';
import type { ClaudeModesCapability } from '../chat.types';

// ── Geniro's own MCP server (agent-to-agent calls) ──────────────────────────
// The two names that identify OUR server and OUR tools inside a CLI's config
// file. They live in the adapter contract because WRITING that file is an
// adapter's job — claude's per-turn `--mcp-config` and cursor's
// `.cursor/mcp.json` merge both spell them — and a name two adapters must
// agree on cannot be owned by a module that imports this one.

/**
 * The name geniro's own MCP server is published under, in EVERY CLI's config:
 * claude's per-turn `--mcp-config` file and the `.cursor/mcp.json` entry
 * merged for a cursor turn. It belongs to us, not to either CLI — spelling it
 * twice is how the two configs would silently name different servers.
 * A foreign entry found under this key is a conflict, never ours to overwrite.
 */
export const GENIRO_MCP_SERVER_KEY = 'geniro';

/**
 * The tool names the per-run MCP endpoint serves. The cursor entry
 * auto-approves exactly these (never `--approve-mcps`, which would
 * blanket-approve the user's other servers too), so the trust expansion stays
 * bounded to what geniro itself publishes.
 */
export const GENIRO_MCP_CALL_TOOLS = [
  'call_agent',
  'await_agent',
  'answer_agent',
] as const;

/**
 * Token/cost accounting for a completed turn. Fields are nullable because not
 * every CLI version reports every figure — the defensive mappers fill what the
 * stream provides and leave the rest null.
 */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * How full the window is NOW — the prompt of the turn's LAST request, which
   * is the whole conversation as the model last saw it.
   *
   * Per-request, never a turn total: a turn re-sends the conversation once per
   * tool call, so adding those up measures work done, not context held (see
   * `claude/utils/claude-usage.utils.ts`). Cache traffic counts — on a resumed session it
   * IS the context — so a CLI that breaks it out reports input + cache-creation
   * + cache-read, and one that doesn't reports its plain input count.
   */
  contextTokens: number | null;
  /**
   * The window that context is measured against, as the CLI reports it for the
   * model it actually ran (claude: 1M for `claude-opus-5[1m]`, 200k for the
   * rest). Null when the CLI says nothing — the consumer then shows the count
   * with no denominator rather than claiming a window nobody confirmed.
   */
  contextWindowTokens: number | null;
  /**
   * WHICH model {@link contextWindowTokens} describes, when the CLI named one.
   *
   * A turn can touch more than one model — a small one runs side errands, and a
   * turn can fall back — so the window belongs to a specific model rather than
   * to the turn. Reported so a consumer caching windows per model can tell that
   * the figure describes the model the turn announced, and decline to file a
   * fallback model's window under the requested one.
   */
  contextModel: string | null;
  costUsd: number | null;
}

/**
 * Normalized streaming event emitted by an agent adapter during one turn. This
 * is the shared model both the Claude and Cursor adapters converge their
 * divergent NDJSON onto (the spec's TextChunk/ReasoningChunk/ToolCallRequest/
 * ToolCallComplete/TurnComplete/TurnCancelled/Error), plus a `session` event
 * carrying the CLI session id for resume.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | {
      /**
       * An INCREMENT of assistant text, as the CLI generates it — the live
       * plane behind a growing bubble.
       *
       * EPHEMERAL BY CONTRACT: a delta is never persisted, never allocated a
       * `seq`, and never replayed. The completed `text` event that follows is
       * the durable record of the same words, so a client that missed deltas
       * (a reconnect mid-block) loses nothing. `mapEventToItem` returns null
       * for it, and that switch is deliberately default-less so a new arm
       * cannot silently become a database row.
       */
      type: 'text_delta';
      text: string;
    }
  | {
      /**
       * The model is REASONING, with the tokens it has spent so far.
       *
       * There is no text to show: headless claude redacts thinking entirely
       * (probe-verified — the block ships an encrypted `signature` and an
       * empty body, and `--include-partial-messages` does not reveal it), so
       * a running total is the only honest signal that the agent is working
       * during an otherwise silent stretch. EPHEMERAL, exactly like
       * {@link AgentEvent} `text_delta`: never persisted, never replayed.
       */
      type: 'thinking_progress';
      tokens: number;
    }
  | {
      /**
       * How full the model's context window is as of the request that just
       * produced output — the live counterpart of the `turn_complete` usage.
       *
       * Every claude `assistant` line carries its own request's prompt-side
       * usage (probe-verified on 2.1.220), so the meter can move DURING a turn
       * instead of jumping once at the end, which is what made it read stale.
       * EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never replayed. The window it is measured against does NOT
       * ride here — the CLI reports that only on the `result` line.
       */
      type: 'context_progress';
      contextTokens: number;
    }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      id: string;
      name: string | null;
      result: unknown;
      isError: boolean;
    }
  | {
      type: 'turn_complete';
      usage: AgentUsage | null;
      stopReason: string | null;
      /**
       * The agent's final answer text as the CLI's result line reports it —
       * what a downstream graph node receives as its input context. Null when
       * the CLI's result carries no text (callers fall back to concatenating
       * the turn's `text` events).
       */
      finalText: string | null;
    }
  | { type: 'turn_cancelled' }
  | { type: 'error'; message: string }
  | { type: 'session'; sessionId: string }
  | {
      /**
       * An adapter-level notice about THIS turn — a capability the CLI did not
       * grant, a request that degraded. Persisted as a `system` transcript item
       * so a degrade is visible to the user rather than silent. NOT terminal:
       * the turn continues after one.
       */
      type: 'notice';
      message: string;
    }
  | {
      /**
       * The CLI reported the session's invokable slash commands (claude's
       * `system/init` `slash_commands`: built-ins + plugin skills + user and
       * project skills/commands, shadowing already resolved — verified live
       * on 2.1.211). Captured into the skill-harvest store keyed by the
       * turn's cwd — never a transcript item.
       */
      type: 'slash_commands';
      commands: string[];
    }
  | {
      /**
       * The MCP servers the CLI had loaded for this turn, with the connection
       * status each was in when the turn began (claude's `system/init`
       * `mcp_servers` — verified live on 2.1.222). Captured into the
       * MCP-harvest store keyed by the turn's cwd and plugin directory — never
       * a transcript item.
       *
       * Reported because the ALTERNATIVE is a cold re-dial: asking a CLI for
       * its servers out of band starts every one of them to health-check it,
       * which is what made the panel take seconds. A turn already knows.
       *
       * A CLI with no such report simply never emits this — there is nothing
       * for an adapter to declare, because the harvest is an optimisation over
       * `listMcpServers`, never the only source.
       */
      type: 'mcp_servers';
      servers: AgentMcpServer[];
    }
  | {
      /**
       * The model this turn is actually running as, named by the CLI at
       * session start (claude's `system/init` `model` — verified live on
       * 2.1.220, where it reads `claude-opus-5[1m]`).
       *
       * Reported because the WINDOW is not: no line before the turn's `result`
       * carries one, so a run's first turn had nothing to scale its live
       * context figure against and fell back to an assumed 200k — which is
       * how a 1M-window model came to be shown measuring against a fifth of
       * its context. Naming the model is enough: the window learned when a
       * turn of that same model finished can be applied from the start.
       *
       * EPHEMERAL — never a transcript row. The durable record of what a turn
       * ran as is the run row itself.
       */
      type: 'turn_model';
      model: string;
    }
  | {
      /**
       * The CLI sent a control message on the stdin dialogue that this adapter
       * does not model, carrying the subtype it was.
       *
       * DIAGNOSTIC ONLY — never a transcript item, never delivered to a turn's
       * consumer: {@link AgentAdapter.start} logs it and drops it. It exists
       * because the mappers are pure module-scope functions that cannot log,
       * so an unmodelled subtype has to travel back to the caller AS DATA to
       * be visible at all. Before it, a control subtype we did not recognize
       * vanished into a bare `return []`.
       */
      type: 'unhandled_control';
      subtype: string;
    }
  | {
      /**
       * The CLI paused mid-turn asking permission for a tool call (`ask`
       * approval mode). The turn stays blocked until the verdict goes back via
       * `AgentTurnHandle.respondApproval(id, …)`.
       */
      type: 'approval_request';
      id: string;
      toolName: string;
      input: unknown;
      /**
       * The CLI flagged this request as a genuine USER QUESTION (claude sets
       * `requires_user_interaction` on AskUserQuestion), not a permission
       * check. The graph executor routes flagged requests from call-initiated
       * turns to the caller (the M4 Q&A bridge) instead of auto-approving.
       */
      requiresUserInteraction?: boolean;
    };

/**
 * One image attached to a turn, as the adapters receive it: a path on disk
 * plus the media type the CLI must be told. Adapter-agnostic — how it reaches
 * the child (content block vs path in the prompt) is each adapter's business.
 */
export interface TurnImage {
  path: string;
  mediaType: string;
}

/**
 * A message the user sent while a turn was ALREADY running, for delivery into
 * that running turn rather than the next one.
 *
 * The same two fields a turn starts with, and deliberately no more: a follow-up
 * changes what the agent is asked, never how it runs. Model, approval mode,
 * cwd and the call surface all belong to the turn that is already in flight.
 */
export interface FollowUpMessage {
  text: string;
  images?: TurnImage[];
}

/**
 * One model a CLI will accept for `--model`, as that CLI reports it.
 *
 * `id` is passed through verbatim — never normalized, since only the CLI knows
 * which spellings it honours. `label` is what the picker shows.
 */
export interface AgentModel {
  id: string;
  label: string;
  /** How this entry was obtained — the UI says so when it is not live. */
  source: 'cli' | 'builtin';
}

/**
 * One reasoning-effort level a CLI accepts for a turn, as that CLI names it.
 *
 * `id` is passed through verbatim — the flag's vocabulary belongs to the CLI,
 * and only its adapter knows which spellings it honours. `label` is what the
 * picker shows.
 */
export interface AgentEffort {
  id: string;
  label: string;
}

/**
 * One skill / slash command a CLI can be invoked with (`/name …`).
 *
 * `kind` separates a skill directory from a plain command file; `source` says
 * where it was found — the project folder, the user's home dir, or `cli` when
 * the CLI itself reported it rather than the disk scan finding it.
 */
export interface AgentSkillEntry {
  name: string;
  description: string | null;
  kind: 'skill' | 'command';
  source: 'project' | 'user' | 'cli';
}

/**
 * Health of one MCP server as the CLI itself reports it.
 *
 * `unknown` is for a row that IS recognisably a row but whose health wording
 * this parser does not know — these rows come out of human-readable CLI
 * output, so a reworded release must not throw.
 *
 * An unrecognised status must cost the BADGE, never the row, in every parser:
 * a server the user cannot see is worse than one whose health is unreadable,
 * and a parser that drops what it cannot read can only announce that when
 * EVERY row drops — a partly unfamiliar listing would otherwise return the
 * rows it understood and silently deny the rest. The CALLER still has to turn
 * "nothing parsed, and no empty-folder sentence" into a stated failure; a
 * listing may never degrade into a confident "this folder has none".
 *
 * `pending` is a server that is configured but deliberately not connected to —
 * claude's unapproved `.mcp.json`, cursor's `not loaded (needs approval)`.
 * `disabled` is one the user switched off in the CLI's own configuration, which
 * geniro cannot undo (cursor's `mcp disable`); it is distinct from the wire's
 * `disabled` flag, which also covers servers geniro itself suppressed.
 */
export type AgentMcpServerStatus =
  'connected' | 'failed' | 'pending' | 'disabled' | 'unknown';

/**
 * One MCP server a CLI agent loads in a given working directory.
 *
 * The set is per-CLI AND per-folder: a CLI resolves project-scoped servers
 * relative to the directory it runs in, so the same agent answers differently
 * in two folders and two agents answer differently in one.
 */
export interface AgentMcpServer {
  name: string;
  /**
   * The command line or URL the CLI reaches the server through, or null when
   * the CLI does not say.
   *
   * Nullable because not every CLI reports it: claude prints
   * `sentry: node s.js - √ Connected`, cursor prints `sentry: ready` and
   * nothing more (probe-verified on 2026.07.23-e383d2b). Reading the CLI's own
   * config file to fill the gap is out of scope — the CLI is the source of
   * truth here, for both agents alike — so null is the honest answer. An empty
   * string would have asserted a command that was never reported, which is the
   * empty-vs-unknown collapse the discriminated result below exists to prevent.
   */
  target: string | null;
  /** Null for the same reason as {@link AgentMcpServer.target}. */
  transport: 'stdio' | 'http' | 'sse' | null;
  status: AgentMcpServerStatus;
  /**
   * The failure reason, or what the server is waiting for — whatever the CLI
   * printed after the status. Null when the status says everything.
   */
  detail: string | null;
}

/**
 * The outcome of asking one CLI for its MCP servers.
 *
 * Discriminated rather than a bare array because an empty array cannot say
 * WHY it is empty, and the three reasons need different words in front of the
 * user: the folder genuinely has none, this CLI has no listing at all, or the
 * CLI could not be reached just now. Collapsing them loses the only
 * distinction the panel exists to make — and, worse, lets a transient failure
 * be cached and shown as "no servers configured".
 *
 * Same shape as {@link TerminalCommandResult}, for the same reason: an adapter
 * reports its refusal as data and the owning module decides how to say it.
 */
export type AgentMcpListingResult =
  { ok: true; servers: AgentMcpServer[] } | { ok: false; reason: string };

/** Everything an adapter needs to list the MCP servers it would load. */
export interface AgentMcpServersInput {
  /**
   * The folder to list in, already validated and canonicalized.
   *
   * Which servers a folder contributes is the CLI's own business: for claude,
   * a project `.mcp.json` is visible ONLY from its own folder (probe-verified
   * on 2.1.220), so listing from a folder that has none yields the
   * folder-INDEPENDENT set — exactly what the graph builder wants, since a
   * workflow has no folder until it runs.
   */
  cwd: string;
  /**
   * A plugin directory whose own MCP servers should be included, already
   * validated and canonicalized. Absent: list without one.
   */
  pluginDir?: string | null;
}

/**
 * Where a server came from, which is what decides whether geniro may switch it
 * off at all.
 *
 * `project` — defined in the folder's own MCP config, and the ONLY scope any
 * verified mechanism can disable. Everything else is `other`: user- and
 * local-scope servers have no non-destructive disable on claude 2.1.220
 * (probe-verified), so a control for them would be a switch that does nothing.
 *
 * `unknown` is not "probably other" — it is a CLI whose config layout has not
 * been verified, and it renders read-only for the same reason.
 */
export type AgentMcpServerScope = 'project' | 'other' | 'unknown';

/**
 * What a CLI's own config files say about a folder, beyond the health listing.
 *
 * They exist because the LISTING cannot answer either question: `claude mcp
 * list` reports a disabled server as though it were live, and prints no scope
 * at all (probe-verified on 2.1.220/2.1.222).
 */
export interface AgentMcpFolderFacts {
  /**
   * Server names this folder currently has switched OFF, as the CLI's OWN
   * config records it — the state a `/mcp` panel in the user's terminal shows.
   *
   * The toggle geniro offers writes that same list, so this is not "what
   * geniro turned off" but "what is off", however it got that way.
   */
  readonly disabled: readonly string[];
  /**
   * Server names that are off in a way geniro CANNOT undo — a rejection the
   * user (or the CLI's own trust prompt) recorded, whose every source copy is
   * UNIONed rather than overridden (probe-verified on claude 2.1.220).
   *
   * A row listed here gets no switch: offering one would be a control that
   * silently does nothing, which is exactly what the design forbids.
   */
  readonly lockedOff: readonly string[];
}

/** Everything an adapter needs to list what it can be invoked with. */
export interface AgentSkillsInput {
  /** The user's project folder, already validated and canonicalized. */
  cwd: string;
  /** The "user" scan root — the real home dir outside tests. */
  homeDir: string;
}

/**
 * How a utility child was spawned, handed to the registration site so it can
 * reap exactly what exists. Produced by `runCommand`, consumed by
 * `childProcessHandle` — the two halves of the process-group pairing, which is
 * why neither is stated by hand at a call site.
 */
export interface AgentSpawnInfo {
  /** The child leads its own process group (see {@link AgentCommandOptions.processGroup}). */
  processGroup: boolean;
}

/** Options for a short-lived utility command a CLI is asked to run. */
export interface AgentCommandOptions {
  /**
   * Handed the spawned child so the caller can register it with
   * `ProcessRegistry` — every child the daemon spawns must be reapable on
   * shutdown, including these one-shot utility ones.
   *
   * `spawnInfo` describes what was ACTUALLY spawned, so the registration site
   * never has to restate it: `childProcessHandle(child, spawnInfo)` is always
   * correct, whereas a hand-written `{ processGroup: true }` at the call site
   * could disagree with the spawn and silently reap nothing.
   */
  onSpawn?: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  /**
   * Handed a full TURN a utility method started (a probe), for the same
   * reason as `onSpawn` — `start()` hands back a handle, not a child, so the
   * two registration seams are separate.
   */
  onTurn?: (handle: AgentTurnHandle) => void;
  timeoutMs?: number;
  /**
   * The folder to run the command in. Absent means the daemon's own cwd, which
   * is what every caller wanted until a command's ANSWER became folder-scoped:
   * `claude mcp list` reports the project's `.mcp.json` servers and the
   * local-scope servers keyed to that directory, so asked from the wrong place
   * it confidently returns a different machine-true list.
   */
  cwd?: string;
  /**
   * Run the child as its own process-group leader, and reap the whole group on
   * every abnormal exit.
   *
   * THE canonical statement of this option; the other sites that touch it point
   * here rather than restating it. Off by default because it is only worth its
   * cost for a command that FORKS: `claude mcp list` health-checks, so it
   * launches the user's own MCP servers as grandchildren, and `kill-tree.ts`
   * names the failure this closes — "a single-PID kill would orphan them".
   *
   * Setting it moves the command off `execFile` entirely, onto `spawn` with
   * `detached` plus a group-killing deadline of our own. That is not an
   * implementation detail worth hiding: `execFile` forwards only
   * cwd/env/uid/gid/shell/windows* to `spawn` and silently drops `detached`,
   * so an `execFile` child can never lead a group no matter what its options
   * bag says, and the reap addresses nobody.
   *
   * `runCommand` owns both halves: it passes the same flag to `onSpawn` as
   * `spawnInfo.processGroup`, so a registration site cannot pair them wrongly.
   */
  processGroup?: boolean;
}

/**
 * The tool-approval modes a caller may ask for. The vocabulary is shared, but
 * which of them a given CLI honours is not — see
 * {@link AdapterConfig.approval}.modes.
 */
export type AgentApprovalMode = 'auto' | 'ask' | 'acceptEdits' | 'plan';

/**
 * What the daemon's probes have established about the INSTALLED CLIs, as an
 * adapter reads it.
 *
 * Structurally the subset of the `GET /v1/capabilities` wire shape that
 * adapters care about, declared HERE rather than imported: `CapabilitiesWire`
 * lives in the graphs module, which imports this one, and an adapter reaching
 * back across that edge would invert the dependency. Structural typing means a
 * consumer holding the full wire object can pass it straight in.
 *
 * The fields are per-CLI by nature — a probe result belongs to the binary it
 * probed — but no CONSUMER has to know which adapter reads which field: it
 * hands the whole bag to `AgentAdapter.approvalSupportFrom` and each adapter
 * takes its own.
 */
export interface InstalledCapabilities {
  claudeModes: ClaudeModesCapability;
}

/**
 * What a per-binary probe established about the INSTALLED CLI's approval
 * modes, in terms no consumer has to know a CLI to build.
 *
 * Tri-state per mode, and the distinction is load-bearing: `false` means a
 * probe PROVED this binary rejects the mode (degrade it), while absent means
 * nobody asked (keep the requested mode, so a genuine rejection still surfaces
 * loudly from the CLI itself instead of being pre-empted by a guess).
 */
export interface InstalledApprovalSupport {
  supported: Partial<Record<AgentApprovalMode, boolean>>;
}

/** The mode a turn actually runs under, and what the transcript owes the user. */
export interface ApprovalResolution {
  mode: AgentApprovalMode;
  /**
   * Null when the requested mode survived; otherwise the one line explaining
   * what the turn runs as instead, and why. The caller persists it as a system
   * item — a degrade the user cannot see reads as enforced permissions that
   * never were.
   */
  degradeReason: string | null;
}

/** Everything an adapter needs to drive one turn. */
export interface AgentTurnInput {
  /** The user's message text for this turn. */
  prompt: string;
  /**
   * Images the user attached to this turn's message, already on disk under the
   * daemon's attachments dir. Delivery is adapter-specific: claude gets real
   * base64 image content blocks in its stream-json stdin payload (probe-verified
   * on 2.1.220 — the model describes the image without touching a tool), while
   * a CLI whose stdin is plain text can only be told the paths and left to open
   * them itself. Empty/absent for a text-only turn.
   */
  images?: TurnImage[];
  /**
   * Working directory the CLI runs in — the user's project folder. The chat
   * service validates this exists and is a directory before the adapter spawns,
   * so the agent is scoped to the user's project, never the daemon's own cwd.
   */
  cwd: string;
  /** Model alias/name (adapter-specific); null/undefined = the CLI default. */
  model?: string | null;
  /**
   * How hard the model should think this turn, spelled as the CLI spells it
   * (one of {@link AgentAdapter.listEfforts}); null/undefined = the CLI's own
   * default, no flag.
   *
   * A plain string rather than a union, for the same reason as `model`: the
   * vocabulary is per-CLI, so a fixed enum here would put one CLI's facts in
   * the shared contract. The caller validates against the adapter's list; an
   * adapter whose CLI has no such control ignores the field entirely.
   */
  effort?: string | null;
  /** Prior CLI session id to resume; null/undefined starts a fresh session. */
  resumeSessionId?: string | null;
  /**
   * Role/system prompt for this turn (graph nodes). Claude appends it to the
   * CLI system prompt (`--append-system-prompt`); ACP has no such parameter,
   * so its driver prepends it to the prompt text. Undefined for plain chat.
   */
  systemPrompt?: string | null;
  /**
   * The caller's "May call" awareness block, naming each callee reachable
   * through `mcpEndpoint`'s tools. Kept SEPARATE from `systemPrompt` because
   * it is only true while the call tools are actually registered: an adapter
   * that ends up withholding the endpoint (an ACP agent that does not
   * advertise HTTP MCP support) must drop this block too, or the agent is
   * instructed to route work through tools it does not have. Join the two
   * with `AgentAdapter.composeSystemPrompt`, never by hand.
   */
  callSurfacePrompt?: string | null;
  /**
   * Tool-approval mode. `ask` blocks each permission-gated tool call on a
   * user verdict (elicitation card); `acceptEdits` auto-approves file edits
   * and asks for everything else; `plan` (chat-only) has the agent plan
   * without executing; `auto` runs unattended with permission checks
   * bypassed. Undefined (legacy chat rows) keeps the CLI's own defaults —
   * no extra permission flags.
   */
  approvalMode?: AgentApprovalMode;
  /**
   * Extra environment merged over `process.env` for the child process — e.g.
   * `CURSOR_API_KEY`. Secrets stay out of SQLite (Keychain-sourced upstream).
   */
  env?: Record<string, string>;
  /**
   * Stream this turn's assistant text as it is generated, if the CLI can.
   *
   * Adapter-agnostic intent, like {@link allowUserQuestions}: the caller says
   * "someone is watching", each CLI decides what that costs. A CLI with no
   * partial-output mode ignores it and streams whole blocks as before.
   */
  streamPartials?: boolean;
  /**
   * This turn may stop and ASK THE USER a question.
   *
   * Adapter-agnostic on purpose: the caller states the intent, and each CLI
   * decides what (if anything) it costs. For claude it is load-bearing —
   * `--dangerously-skip-permissions` strips the AskUserQuestion tool entirely
   * (probe-verified), so an `auto` turn that wants the question channel must
   * spawn on the stdio permission dialogue instead and have the DAEMON stand
   * in for the bypass, auto-approving plain permission requests. A CLI with no
   * question channel ignores this and spawns exactly as before.
   */
  allowUserQuestions?: boolean;
  /**
   * Trust the turn's cwd without prompting (cursor `--trust`, headless-only).
   * Needed when the cwd is a daemon-created directory the user never opened —
   * the MCP-trust probe's temp workspace. User-project turns never set it:
   * trusting the user's own worktree is the user's decision, not the daemon's.
   */
  trustWorkspace?: boolean;
  /**
   * A plugin directory this turn loads, and no other turn's.
   *
   * Already validated and canonicalized by the caller — an adapter puts it
   * straight into argv and must never be the thing that first checks it.
   * Session-scoped: nothing is installed and no user config is written.
   *
   * A CLI with no plugin mechanism simply ignores the field.
   */
  pluginDir?: string | null;
  /**
   * Loopback MCP endpoint granting this turn the agent-call tools
   * (call_agent / await_agent / answer_agent). Delivery is adapter-specific —
   * claude gets a per-turn config file referenced by `--mcp-config` (the
   * token travels IN the 0600 file, never argv); the ACP adapter sends it as
   * an HTTP header inside a `session/new` stdin frame. Absent or null: the
   * turn gets no call tools.
   */
  mcpEndpoint?: {
    url: string;
    token: string;
    /**
     * The name geniro's own MCP server is published under for this turn.
     *
     * The ACP path uses it verbatim (per-run, so no project server can
     * collide). Claude currently IGNORES it and publishes under the shared
     * {@link GENIRO_MCP_SERVER_KEY}, because the renderer drops geniro's own
     * call tools from the transcript by matching that fixed prefix. Since
     * `--strict-mcp-config` is no longer passed, `prepareTurn`'s
     * `definesGeniroServer` guard stands in for the uniqueness this field
     * gives ACP for free.
     */
    serverName: string;
    /** Override for the CLI's MCP tool timeout (sync calls run minutes). */
    toolTimeoutMs?: number;
  } | null;
}

/**
 * One CLI process, and the turns an adapter runs on it.
 *
 * Every turn goes through a session — including the ordinary one-turn kind, so
 * there is a single code path rather than a branch on which CLI is being
 * talked to. A CLI that cannot host more than one turn per process simply
 * yields a session whose SECOND {@link AgentSession.startTurn} answers null,
 * which is the same answer a caller gets for a session that has died or whose
 * argv no longer fits — and it means exactly one thing everywhere: spawn a
 * fresh one.
 *
 * Why a session exists at all: a CLI boots the user's MCP servers when it
 * starts, and an MCP server can own something expensive — a browser the user
 * is logged into. A process per turn tears that down on every message.
 */
export interface AgentSession {
  /**
   * Open a turn on this process. Null when this session cannot serve it: the
   * process is gone, a turn is already in flight, this CLI hosts one turn per
   * process, or the input would need different argv than the process was
   * spawned with (a changed model, folder or plugin directory).
   */
  startTurn(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle | null;
  /** Alive, with no turn in flight — ready to take another one. */
  readonly idle: boolean;
  /** The process has not been observed to end. */
  readonly alive: boolean;
  /**
   * Terminate the process group — the CLI plus every tool/MCP grandchild.
   *
   * This is the ONLY thing that stops a run-scoped process, so whoever holds
   * the session owns that obligation: nothing else will reap it.
   */
  close(): void;
  /** Resolves once the process is gone. Never rejects. */
  readonly closed: Promise<void>;
}

export type TurnStdin = (payload: string) => boolean;

/** The two channels a {@link TurnDriver} owns for the turn it is driving. */
export interface TurnIo {
  write: TurnStdin;
  emit: (event: AgentEvent) => void;
}

/**
 * Per-turn protocol state for ONE turn of one CLI.
 *
 * The default driver (built by `AgentAdapter.createTurnDriver`) is stateless:
 * it just forwards each parsed stdout line to the adapter's `mapMessage`, which
 * is all a one-shot stream-json CLI needs. An adapter whose CLI speaks a
 * STATEFUL, bidirectional protocol — ACP's JSON-RPC handshake, where the next
 * message to send depends on the last one received — overrides
 * `createTurnDriver` to return an instance holding that turn's own state.
 *
 * A per-turn object (rather than more adapter methods) is what makes this safe
 * under graph fan-out: one adapter instance drives N concurrent turns, so
 * protocol state must never live on the adapter.
 */
export interface TurnDriver {
  /**
   * Called once the child's stdin is wired, before any stdout is parsed — the
   * driver's chance to open a conversation the CLI expects the client to start.
   */
  onStdinReady?(io: TurnIo): void;
  /** Map one parsed stdout line to zero or more normalized events. */
  onMessage(obj: unknown): AgentEvent[];
  /**
   * Encode one approval verdict as the payload the CLI expects. Undefined =
   * this CLI has no approval protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined;
}

/** Handle to an in-flight turn. */
export interface AgentTurnHandle {
  /**
   * Resolves when the turn finishes by any path (the CLI exits, errors, or is
   * cancelled). Never rejects — terminal outcomes arrive as `error` /
   * `turn_cancelled` events first, so callers await a single settle point.
   */
  readonly done: Promise<void>;
  /** Terminate the underlying CLI process for this turn. */
  cancel(): void;
  /**
   * Answer an `approval_request` event: allow unblocks the tool call (echoing
   * `updatedInput` — the input the request carried); deny rejects it and the
   * agent continues without the tool. Returns whether the verdict was actually
   * delivered — false once the turn has settled/ended (a late verdict must not
   * be recorded as applied) and for adapters whose CLI has no approval
   * protocol.
   */
  respondApproval(id: string, allow: boolean, updatedInput?: unknown): boolean;
  /**
   * Hand the RUNNING turn another user message. Returns whether it was
   * actually delivered — false once the turn has settled, and false for a CLI
   * with no such channel, so a caller can fall back to queueing it for the
   * next turn without asking the adapter what kind it is.
   *
   * Probe-verified on claude 2.1.222: a second `{"type":"user"}` line written
   * to a still-open stream-json stdin is picked up at the next tool boundary
   * of the turn already in flight — a message sent 8s into a 20s command was
   * answered at 29s, in the same process and under the same `result` line.
   * That is what the CLI itself does with a follow-up typed mid-turn, and it
   * is why "queued" here means seconds rather than "after everything finishes".
   *
   * ACP has no equivalent: `session/prompt` is one request per turn, and the
   * protocol gives a client no way to add to a prompt already accepted. Its
   * adapter therefore answers false and the caller keeps the message queued.
   */
  sendUserMessage(message: FollowUpMessage): boolean;
  /**
   * Re-mode the tool-approval posture of the turn ALREADY RUNNING, returning
   * whether the CLI was actually told.
   *
   * Honest in both directions, like {@link AgentTurnHandle.sendUserMessage} —
   * and here the cost of a dishonest true is higher than a dropped message.
   * This is the permission surface: ACKing a change the running turn will not
   * honour tells the user a safety posture they do not have, which is exactly
   * what the caller's refusal exists to prevent.
   *
   * False is the honest answer for a turn with no way to be told, and that is
   * not hypothetical: a claude turn spawned under
   * `--dangerously-skip-permissions` has no permission prompt tool wired at
   * all, so no message could reintroduce a gate it was started without.
   */
  setApprovalMode(mode: AgentApprovalMode): boolean;
}

/** One question a CLI asked the user, projected out of its own tool payload. */
export interface AdapterQuestion {
  /** The question text, ready for a caller envelope or a renderer card. */
  text: string;
  /** Every option label offered, flat across questions; [] when free-text only. */
  options: string[];
}

/** What the mirror is being opened ON — one run's one thread. */
export interface HandoffInput {
  /** The session to open, or null when the thread has produced none yet. */
  sessionId: string | null;
  /** The model the run is chatting as, or null for the CLI's own default. */
  model: string | null;
}

/**
 * How the user is handed THIS conversation, so they can carry it on themselves.
 *
 * A `command` is a shell invocation that opens the conversation in the CLI's
 * own TUI. The union has one arm today because that is what any CLI here can
 * actually do; the shape exists so a second delivery — a deeplink or a web
 * session URL, once an agent offers one — is a new arm rather than a new
 * subsystem. Nothing outside the adapter layer branches on which it is.
 *
 * A refusal is DATA, not an exception: the adapter layer knows nothing about
 * HTTP, and the owning module decides how to say it.
 */
export type HandoffResult =
  | { ok: true; kind: 'command'; command: string; args: string[] }
  | { ok: false; reason: 'unsupported' | 'no-session' };

/**
 * Everything about ONE CLI that is STATIC — true of the binary before any turn
 * runs, and knowable without asking it anything.
 *
 * One object per adapter, declared in that adapter's `<name>.const.ts` and
 * returned by `AgentAdapter.getConfig()`, so every question whose only per-CLI input
 * is a VALUE is answered once, concretely, on the base class. A field here is
 * the reason a `listEfforts` / `listSkills` / `resolveApprovalMode` override no
 * longer exists on either adapter.
 *
 * What deliberately does NOT belong here:
 * - anything env-dependent (`command` is derived from `kind` through
 *   `resolveAgentBinary`, so a Settings cliPaths override still takes effect
 *   per access);
 * - anything the INSTALLED binary has to be asked (its model list, its reported
 *   commands, whether it streams partials) — config carries only how to ask and
 *   what to fall back to;
 * - anything with per-turn branching (argv assembly, stdin payload, child env)
 *   — those stay `buildArgs` / `buildStdinPayload` / `buildEnv`.
 */
export interface AdapterConfig {
  // ── Identity ────────────────────────────────────────────────────────────
  /**
   * The agent this adapter drives. Also the key `resolveAgentBinary` looks up,
   * so the binary name is never spelled a second time.
   */
  readonly kind: AgentKind;

  // ── Asking the user ─────────────────────────────────────────────────────
  /**
   * The tool this CLI uses to ask the USER a question, or null when it has no
   * question channel at all. The ONE discriminator between a genuine question
   * and a permission check — no service, executor or util may spell a tool name
   * itself.
   */
  readonly questionToolName: string | null;

  // ── Approval policy ─────────────────────────────────────────────────────
  readonly approval: {
    /**
     * Every mode this CLI honours as a user-visible choice. A mode outside this
     * list is refused where the choice is MADE (chat create/patch).
     */
    readonly modes: readonly AgentApprovalMode[];
    /**
     * The subset of `modes` whose support cannot be known from the CLI's name
     * alone and must be PROVED against the installed binary. It decides whether
     * a run pays for a probe turn at all; `[]` means every claimed mode is real.
     */
    readonly probedModes: readonly AgentApprovalMode[];
    /**
     * What a mode degrades to once a probe PROVED the installed binary rejects
     * it, plus the line the transcript owes the user.
     *
     * A probed mode deliberately ABSENT from this table rides through and is
     * rejected loudly by the CLI. That absence is policy, not an oversight —
     * see claude's `plan`, where degrading a no-execute mode into an executing
     * one would invert the intent the user selected it for.
     */
    readonly degradeOnProbeFail: Readonly<
      Partial<
        Record<
          AgentApprovalMode,
          { readonly to: AgentApprovalMode; readonly reason: string }
        >
      >
    >;
    /**
     * The line owed to the user when a CLI with exactly ONE honoured mode is
     * asked for a different one — evaluated only when `modes.length === 1`, and
     * checked BEFORE `degradeOnProbeFail` (a single-mode CLI has nothing to
     * probe). Null when `modes` has more than one entry.
     */
    readonly soleModeDegradeReason:
      ((requested: AgentApprovalMode) => string) | null;
  };

  // ── Reasoning effort ────────────────────────────────────────────────────
  /**
   * The `--effort` vocabulary this CLI accepts, weakest first, or `[]` when it
   * has no such control at all. WRITTEN DOWN, never scraped from `--help`: a
   * CLI can accept a level its own help omits.
   */
  readonly efforts: readonly AgentEffort[];

  // ── Models ──────────────────────────────────────────────────────────────
  /**
   * The documented alias / fallback set — the FLOOR of `listModels`, never the
   * whole of it, and what a CLI that cannot be asked answers with so the picker
   * is never empty. How the live list is obtained stays `listModels`, which is
   * the one member config cannot express (a home-file read vs a subcommand).
   */
  readonly builtinModels: readonly AgentModel[];

  // ── Skills / commands on disk ───────────────────────────────────────────
  /**
   * Where this CLI keeps what it can be invoked with, as path SEGMENTS joined
   * under each root (the project cwd first, then the user's home dir). Within
   * one root, `skills` are scanned before `commands` — the two arrays' order IS
   * the shadowing order the CLI itself applies, which the caller's
   * first-occurrence-wins de-dup relies on.
   */
  readonly skillRoots: {
    /** `<root>/<…>/<name>/SKILL.md` dirs; `[]` when the CLI has no skills convention. */
    readonly skills: readonly (readonly string[])[];
    /** `<root>/<…>/**.md` command files; `[]` when the CLI has no commands convention. */
    readonly commands: readonly (readonly string[])[];
  };

  // ── Live (token-level) streaming ────────────────────────────────────────
  /**
   * How to establish whether the INSTALLED binary can stream partial assistant
   * text. Null when the CLI has no such mode at all, which answers
   * `supportsLiveStream` false without spawning anything.
   */
  readonly liveStream: {
    /** Utility argv whose stdout is searched — `--help` is the cheapest honest source. */
    readonly probeArgs: readonly string[];
    /**
     * ONE string, used twice by design: pushed onto argv when a turn asks for
     * partials, and searched for in `probeArgs`' stdout. The same binary that
     * would reject it on argv is the one that advertises it, so a single field
     * makes the two reads incapable of drifting apart.
     */
    readonly flag: string;
  } | null;

  // ── Commands the CLI reports about ITSELF ───────────────────────────────
  /**
   * How to harvest the built-ins and plugin commands that exist nowhere on disk
   * to be scanned: start one turn in a throwaway cwd and cancel it the instant
   * the normalized `slash_commands` event lands. Null when the CLI makes no such
   * report, which answers `listReportedCommands` with `[]` and never spawns.
   */
  readonly reportedCommands: {
    /** Never reached by the model — the turn is cancelled the moment init lands. */
    readonly probePrompt: string;
    /** A hung probe must not wedge the caller forever. */
    readonly probeTimeoutMs: number;
    /** Defensive bound on the reported list. */
    readonly maxCommands: number;
    /** Names starting with this are the CLI's INTERNALS, not things a user invokes. */
    readonly internalPrefix: string | null;
  } | null;

  // ── Agent-to-agent calls (MCP) ──────────────────────────────────────────
  readonly mcp: {
    /**
     * Whether the call tools are withheld until a machine-level trust probe has
     * PASSED. True is the cautious answer: the shut-out caller degrades VISIBLY.
     */
    readonly callToolsRequireTrustProbe: boolean;
    /**
     * Whether an MCP endpoint reaches this CLI ONLY through a config file in the
     * run's own cwd, merged before the spawn and restored after. False means the
     * endpoint rides the turn itself, so nothing outside it ever sees the token.
     */
    readonly endpointRequiresCwdConfig: boolean;
    /**
     * Why this CLI's loaded MCP servers cannot be listed, or null when they
     * can be.
     *
     * A VALUE rather than a method because nothing acts on it — it is carried
     * to the UI and shown. It exists so that "this folder has no servers" and
     * "this CLI cannot tell us" stay different answers: both are an empty list,
     * and a reader that cannot distinguish them either invents a reason or
     * branches on which CLI it is holding. This field is what lets the panel
     * say something true without ever asking that question.
     */
    readonly listingUnavailableReason: string | null;
    /**
     * Why NO server of this CLI can be switched off, or null when some can.
     *
     * SEPARATE from {@link listingUnavailableReason} on purpose: listing and
     * toggling are different capabilities that merely coincide today. Reading
     * one to answer the other would tell the first CLI that can list but not
     * toggle (or the reverse) a reason that does not answer the question.
     */
    readonly toggleUnavailableReason: string | null;
    /**
     * Why a row the user turned down in their OWN config carries no switch.
     *
     * The one remaining reason a switchable CLI still shows a locked row: the
     * toggle writes the CLI's own per-folder list, which reaches every scope,
     * but it cannot undo a rejection whose every source copy the CLI unions.
     */
    readonly userDisabledReason: string;
  };

  // ── Plugin directory ────────────────────────────────────────────────────
  /** Whether this CLI can load a plugin directory for one invocation. */
  readonly plugin: {
    /**
     * Why this CLI cannot load a plugin directory, or `null` when it can.
     *
     * Non-null is the "this CLI has no such thing" answer, and it is what
     * stops a node's `pluginDir` being validated, refused, or spawned for an
     * agent that would ignore it — geniro becoming the silent one is exactly
     * the failure the field exists to prevent.
     */
    readonly unavailableReason: string | null;
  };

  // ── Handing the conversation to the user ────────────────────────────────
  /**
   * How this CLI reopens one of ITS OWN sessions interactively, so the user can
   * take the conversation over — or the reason it cannot.
   *
   * Probe-verified that the reason arm is not hypothetical: cursor-agent
   * accepts `--resume <id>`, but an ACP session id is not in its chat store, and
   * resuming an unknown id SILENTLY CREATES AN EMPTY CHAT rather than failing.
   * A missing handoff there is not a gap to paper over — offering the button
   * would drop the user into a blank conversation with no error anywhere.
   */
  readonly handoff:
    | {
        readonly kind: 'resume-command';
        /** The flag that resumes a session id — argv is `[resumeFlag, sessionId]`. */
        readonly resumeFlag: string;
        /**
         * The flag naming the model, so a mirror opens on the SAME model the chat
         * is running.
         *
         * Without it the TUI resumes under the CLI's own default, which is a
         * different model with a different window — so the mirror of a 1M-window
         * chat reported a 200k context beside it and read as a different
         * conversation entirely.
         *
         * Required, not nullable: a CLI whose TUI cannot be told a model would
         * declare that by having no `terminal` block worth resuming into at all.
         * A real one re-adds the null arm with its reason, and a test that enters
         * it.
         */
        readonly modelFlag: string;
        /**
         * What a resumable session id looks like for this CLI. A value produced by
         * a DIFFERENT CLI must not be handed to this one's TUI.
         */
        readonly sessionIdPattern: RegExp;
      }
    | {
        readonly kind: 'unavailable';
        /** Stated to the user verbatim, so "no button" is never unexplained. */
        readonly reason: string;
      };
}
