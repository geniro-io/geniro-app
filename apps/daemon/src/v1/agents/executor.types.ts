import type { AgentKind } from '../runs/runs.types';

/**
 * Token/cost accounting for a completed turn. Fields are nullable because not
 * every CLI version reports every figure — the defensive mappers fill what the
 * stream provides and leave the rest null.
 */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
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
    }
  | { type: 'turn_cancelled' }
  | { type: 'error'; message: string }
  | { type: 'session'; sessionId: string };

/** Everything an adapter needs to drive one turn. */
export interface ExecutorInput {
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
   * Extra environment merged over `process.env` for the child process — e.g.
   * `CURSOR_API_KEY`. Secrets stay out of SQLite (Keychain-sourced upstream).
   */
  env?: Record<string, string>;
}

/** Handle to an in-flight turn. */
export interface ExecutorHandle {
  /**
   * Resolves when the turn finishes by any path (the CLI exits, errors, or is
   * cancelled). Never rejects — terminal outcomes arrive as `error` /
   * `turn_cancelled` events first, so callers await a single settle point.
   */
  readonly done: Promise<void>;
  /** Terminate the underlying CLI process for this turn. */
  cancel(): void;
}

/**
 * Drives one CLI coding agent headlessly, normalizing its NDJSON stream to
 * {@link AgentEvent}s. One instance per agent kind; `start` is called per turn.
 */
export interface Executor {
  readonly kind: AgentKind;
  /**
   * Start a turn. Events are delivered to `onEvent` in stream order. The
   * returned handle settles via `done` and can `cancel` the turn.
   */
  start(
    input: ExecutorInput,
    onEvent: (event: AgentEvent) => void,
  ): ExecutorHandle;
}
