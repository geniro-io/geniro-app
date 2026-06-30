/**
 * Persisted enum shapes for the SQLite entities. Daemon-internal — these model
 * runtime/history rows, not a wire contract. The HTTP/WS DTOs that expose this
 * data to the UI are generated from the daemon's OpenAPI spec (M2).
 */

export type RunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type NodeStatus = RunStatus | 'skipped';

/**
 * Conversation item kind. M1 stores items as opaque rows; the full normalized
 * taxonomy (mirroring the engine's event model) is refined in M2.
 */
export type ItemKind =
  'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'system' | 'error';
