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

/** Everything an adapter needs to drive one turn. */
export interface AgentTurnInput {
  /** The user's message text for this turn. */
  prompt: string;
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

/**
 * Writes one already-framed payload to the running CLI's stdin. Returns false
 * once the turn has settled or its terminal event has been emitted (the child
 * is gone or on its way out), so a driver drops the write instead of throwing.
 */
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
}
