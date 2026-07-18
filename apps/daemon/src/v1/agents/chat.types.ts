import type { AgentKind, ItemKind, RunStatus } from '../runs/runs.types';

/**
 * The single-agent chat has exactly one node; its CLI session id is keyed
 * under this constant in `node_state` (whose PK is runId+nodeId). `Item.nodeId`
 * stays null for single-agent transcript rows, per the entity contract. Shared
 * with the terminals module, which resolves the same key to `--resume` the
 * chat's CLI session in a live TUI.
 */
export const SINGLE_AGENT_NODE = 'agent';

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/approval-card.tsx
 * MAX_ANSWER_LENGTH.
 *
 * Sanity cap on a question answer (M4) — it travels as ONE stdin control
 * line into the paused CLI turn. Enforced at BOTH ingress points of the
 * answer channel: the WS verdict (invalid/oversize → status:'invalid', request
 * remains pending) and the MCP answer_agent tool (oversize → INVALID_ARGS).
 */
export const MAX_ANSWER_LENGTH = 32_768;

/**
 * A persisted transcript item projected to the wire — `payload` is parsed back
 * from its stored JSON string so the renderer receives structured data, not a
 * doubly-encoded string. This is the shape the daemon emits over `/ws` and the
 * REST history read; the UI mirrors it in `shared/contracts.ts`.
 */
export interface ItemWire {
  id: string;
  runId: string;
  nodeId: string | null;
  seq: number;
  kind: ItemKind;
  role: string | null;
  payload: unknown;
  createdAt: string;
}

/** One persisted item, ready to fan out to its run's WS room (persist-then-emit). */
export interface RunItemEvent {
  runId: string;
  item: ItemWire;
}

/** A run projected to the wire (chat and workflow runs share the shape). */
export interface RunWire {
  id: string;
  status: RunStatus;
  title: string | null;
  agentKind: AgentKind | null;
  /** Workflow slug for a graph run; null for a single-agent chat. */
  workflowId: string | null;
  cwd: string | null;
  model: string | null;
  createdAt: string;
  /**
   * Last write to the run row — every send flips status to `running` and every
   * settle writes the terminal status, so this is the run's last-activity time.
   */
  updatedAt: string;
  /**
   * Text of the run's latest `message` item (the chat list's preview line).
   * Null when the run has no messages yet; list endpoints enrich it, while
   * create paths return null (a fresh run genuinely has none).
   */
  lastMessage: string | null;
}
