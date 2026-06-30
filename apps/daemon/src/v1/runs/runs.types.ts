/**
 * Persisted enum shapes for the SQLite entities. Daemon-internal — these model
 * runtime/history rows, not a wire contract. The HTTP/WS DTOs that expose this
 * data to the UI are generated from the daemon's OpenAPI spec (M2).
 */

export type RunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type NodeStatus = RunStatus | 'skipped';

/**
 * Conversation item kind — the normalized 11-kind transcript taxonomy. M1
 * shipped the first 6; M2 widens it additively (a plain TEXT column, so the
 * `safe: true` schema sync needs no migration). `message` carries user and
 * assistant text (disambiguated by `Item.role`); `usage`/`status`/`attachment`
 * are defined here for the event model and forward-compat though M2 only
 * emits a subset.
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
  | 'status';

/** A CLI coding agent the daemon can drive headlessly (M2: one at a time). */
export type AgentKind = 'claude' | 'cursor-agent';
