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
   * Tool-approval mode for graph nodes. `ask` blocks each permission-gated
   * tool call on a user verdict (elicitation card); `auto` runs unattended
   * with permission checks bypassed. Undefined (plain chat) keeps the CLI's
   * own defaults — no extra permission flags.
   */
  approvalMode?: 'auto' | 'ask';
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
   * (call_agent / await_agent). Delivery is adapter-specific — claude gets a
   * per-turn config file referenced by `--mcp-config` (the token travels IN
   * the 0600 file, never argv); cursor callers land in milestone 3. Absent
   * or null: the turn gets no call tools.
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
