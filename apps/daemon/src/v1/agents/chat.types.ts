import type { AgentKind, ItemKind, RunStatus } from '../runs/runs.types';

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
}
