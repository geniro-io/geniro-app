/**
 * Persisted enum shapes for the SQLite entities. Daemon-internal — these model
 * runtime/history rows, not a wire contract. The HTTP/WS DTOs that expose this
 * data to the UI are generated from the daemon's OpenAPI spec (M2).
 */

export type RunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type NodeStatus = RunStatus | 'skipped';

/**
 * Conversation item kind — the normalized transcript taxonomy. M1 shipped the
 * first 6; M2 widened it to 11; M3 adds the two approval kinds (a plain TEXT
 * column, so the `safe: true` schema sync needs no migration). `message`
 * carries user and assistant text (disambiguated by `Item.role`);
 * `usage`/`status`/`attachment` are defined here for the event model and
 * forward-compat though only a subset is emitted. `approval_request` is an
 * `ask`-node's paused tool call awaiting a verdict; `approval_verdict` records
 * the user's answer, closing the pair for reconnect replay.
 *
 * The agent-calls milestone adds the three call kinds: `call_started` (a
 * caller invoked call_agent — attributed to the CALLER node), `call_result`
 * (the call's envelope settled — also the caller's), and `await_collected`
 * (an async result was picked up via await_agent). The callee's own turn
 * streams as regular items under the callee's nodeId. The Q&A bridge (M4)
 * adds `call_question` (a call-initiated callee raised AskUserQuestion —
 * parked, awaiting the caller) and `call_answer` (how it resolved: answered
 * via answer_agent, TTL timeout, or orphaned by the caller ending) — both
 * attributed to the CALLER node like the other call kinds.
 */
export type ItemKind =
  | 'message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'turn_complete'
  | 'turn_cancelled'
  | 'usage'
  | 'system'
  | 'error'
  | 'attachment'
  | 'status'
  | 'approval_request'
  | 'approval_verdict'
  | 'call_started'
  | 'call_result'
  | 'await_collected'
  | 'call_question'
  | 'call_answer';

/** A CLI coding agent the daemon can drive headlessly (M2: one at a time). */
export type AgentKind = 'claude' | 'cursor-agent';
