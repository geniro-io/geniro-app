import type { ChildProcess } from 'node:child_process';

/**
 * Token/cost accounting for a completed turn. Fields are nullable because not
 * every CLI version reports every figure — the defensive mappers fill what the
 * stream provides and leave the rest null.
 */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * The turn's full prompt-side footprint — what the agent's context window
   * actually held. For claude this is input + cache-creation + cache-read
   * tokens (`input_tokens` alone excludes cache traffic and wildly
   * understates a resumed conversation); CLIs that don't break out cache
   * tokens report their plain input count here.
   */
  contextTokens: number | null;
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
  approvalMode?: 'auto' | 'ask' | 'acceptEdits' | 'plan';
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
