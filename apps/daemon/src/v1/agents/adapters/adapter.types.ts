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
   * rest). Null when the CLI says nothing — the consumer then falls back to a
   * default rather than claiming a window nobody confirmed.
   */
  contextWindowTokens: number | null;
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

/** Everything an adapter needs to list what it can be invoked with. */
export interface AgentSkillsInput {
  /** The user's project folder, already validated and canonicalized. */
  cwd: string;
  /** The "user" scan root — the real home dir outside tests. */
  homeDir: string;
}

/** Options for a short-lived utility command a CLI is asked to run. */
export interface AgentCommandOptions {
  /**
   * Handed the spawned child so the caller can register it with
   * `ProcessRegistry` — every child the daemon spawns must be reapable on
   * shutdown, including these one-shot utility ones.
   */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Handed a full TURN a utility method started (a probe), for the same
   * reason as `onSpawn` — `start()` hands back a handle, not a child, so the
   * two registration seams are separate.
   */
  onTurn?: (handle: AgentTurnHandle) => void;
  timeoutMs?: number;
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
   * CLI system prompt (`--append-system-prompt`); Cursor has no such flag, so
   * its adapter prepends it to the prompt text. Undefined for plain chat.
   */
  systemPrompt?: string | null;
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
   * Loopback MCP endpoint granting this turn the agent-call tools
   * (call_agent / await_agent / answer_agent). Delivery is adapter-specific —
   * claude gets a per-turn config file referenced by `--mcp-config` (the
   * token travels IN the 0600 file, never argv); cursor delivery BYPASSES the
   * adapter entirely: the executor merges a `geniro` entry into the run cwd's
   * `.cursor/mcp.json` around the turn (the cursor-mcp-merge service), so a
   * cursor turn's input carries this field only for the timeout override.
   * Absent or null: the turn gets no call tools.
   */
  mcpEndpoint?: {
    url: string;
    token: string;
    /** Override for the CLI's MCP tool timeout (sync calls run minutes). */
    toolTimeoutMs?: number;
  } | null;
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
}

/** One question a CLI asked the user, projected out of its own tool payload. */
export interface AdapterQuestion {
  /** The question text, ready for a caller envelope or a renderer card. */
  text: string;
  /** Every option label offered, flat across questions; [] when free-text only. */
  options: string[];
}

/** What resolving a terminal-mirror invocation produced. */
export type TerminalCommandResult =
  | { ok: true; command: string; args: string[] }
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
  };

  // ── Interactive terminal mirror ─────────────────────────────────────────
  /**
   * How to reopen an existing headless session in the CLI's own TUI, or null
   * when this CLI has no such mode (the mirror is then refused for it, rather
   * than opening an unrelated fresh TUI).
   */
  readonly terminal: {
    /** The flag that resumes a session id — argv is `[resumeFlag, sessionId]`. */
    readonly resumeFlag: string;
    /**
     * What a resumable session id looks like for this CLI. A value produced by
     * a DIFFERENT CLI must not be handed to this one's TUI.
     */
    readonly sessionIdPattern: RegExp;
  } | null;
}
