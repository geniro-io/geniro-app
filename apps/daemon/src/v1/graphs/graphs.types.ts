import { z } from 'zod';

import type { AgentKind, ItemKind, NodeStatus } from '../runs/runs.types';

/**
 * The workflow domain model — the zod half of the Geniro graph-core port
 * (geniro apps/api graphs.types.ts:134-167), trimmed to geniro-app's node
 * shapes: a `kind`-discriminated union of agent nodes (CLI coding agents
 * carrying agent/model/role/approval — no template+config indirection) and
 * trigger nodes (the graph's entry points, geniro-style: a run fires a
 * trigger, never an agent directly). YAML files (`*.geniro.yaml`) are the
 * source of truth for these shapes; SQLite stores runtime/history only.
 */

/** Agent kinds a node may run — kept in lockstep with `AgentKind`. */
export const WORKFLOW_AGENT_KINDS = ['claude', 'cursor-agent'] as const;

/** Compile-time check that the zod enum stays aligned with `AgentKind`. */
const _agentKindLockstep: readonly AgentKind[] = WORKFLOW_AGENT_KINDS;
void _agentKindLockstep;

/**
 * Node kinds a workflow may contain. A new kind is added here plus one entry
 * in `NODE_CONNECTION_RULES` (and its schema branch in `WorkflowNodeSchema`)
 * — nothing else has to change for the graph validation and the builder to
 * understand it.
 */
export const NODE_KINDS = ['agent', 'trigger'] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Trigger types a trigger node may carry — `manual` (fired by hand) today. */
export const TRIGGER_KINDS = ['manual'] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

/**
 * Edge kinds: `data` — the producer's final text feeds the consumer's prompt
 * (the DAG flow); `call` — the source may invoke the target at runtime via
 * the call_agent tool (grants permission only; no data flows along it).
 */
export const EDGE_KINDS = ['data', 'call'] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/**
 * One typed connection rule of a node kind (the geniro `ConnectionRule`
 * model, trimmed to kind-matching — geniro-app has no template indirection):
 * "this side of the node accepts/produces edges to nodes of `kind`".
 * `required` = the graph is invalid until at least one such edge exists;
 * `multiple` = more than one such edge may attach (default: single).
 */
export interface ConnectionRule {
  /** Edge kind this rule governs — data-flow and call wires are separate ports. */
  edge: EdgeKind;
  kind: NodeKind;
  required?: boolean;
  multiple?: boolean;
}

/**
 * The connection contract per node kind — the single source of truth for
 * which edges are legal, enforced by `validateWorkflowGraph` on save and run
 * and mirrored by the renderer (info popup + canvas `isValidConnection`).
 * An edge `from → to` is legal iff `from`'s kind lists `to`'s kind in
 * `outputs` AND `to`'s kind lists `from`'s kind in `inputs`.
 */
export const NODE_CONNECTION_RULES: Record<
  NodeKind,
  { inputs: readonly ConnectionRule[]; outputs: readonly ConnectionRule[] }
> = {
  agent: {
    inputs: [
      { edge: 'data', kind: 'agent', multiple: true },
      { edge: 'data', kind: 'trigger' }, // at most one trigger feeds an agent
      { edge: 'call', kind: 'agent', multiple: true },
    ],
    outputs: [
      { edge: 'data', kind: 'agent', multiple: true },
      { edge: 'call', kind: 'agent', multiple: true },
    ],
  },
  trigger: {
    // Triggers are pure entry points: nothing may feed one, and firing fans
    // out to any number of agents. Call wires never touch triggers.
    inputs: [],
    outputs: [{ edge: 'data', kind: 'agent', multiple: true }],
  },
};

/**
 * Per-node approval mode: `auto` lets the agent run its tools unattended;
 * `ask` routes tool-permission requests to the renderer as elicitation cards
 * and blocks the tool call until a verdict comes back.
 */
export const ApprovalModeSchema = z.enum(['auto', 'ask']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** Envelope fields every node kind shares. */
const workflowNodeBase = {
  id: z.string().min(1).describe('Unique node id within the workflow'),
  name: z.string().min(1).optional().describe('Display name (defaults to id)'),
};

/** One agent node — a CLI coding agent running one turn per run. */
export const WorkflowAgentNodeSchema = z.object({
  ...workflowNodeBase,
  kind: z.literal('agent'),
  agent: z.enum(WORKFLOW_AGENT_KINDS).describe('CLI agent that runs this node'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe('Model alias; omitted = CLI default'),
  role: z
    .string()
    .optional()
    .describe('Role/system prompt prepended to the node turn'),
  approval: ApprovalModeSchema.default('auto').describe(
    'Tool-approval mode for this node',
  ),
});

/**
 * One trigger node — the graph's entry point. It runs no CLI: firing it
 * (today only `manual` — submitting a run prompt) seeds its downstream
 * agents. A run refuses to start unless every root node is a trigger.
 */
export const WorkflowTriggerNodeSchema = z.object({
  ...workflowNodeBase,
  kind: z.literal('trigger'),
  trigger: TriggerKindSchema.default('manual').describe(
    'How this trigger fires',
  ),
});

/**
 * One node of a workflow DAG, discriminated by `kind`. Strict: `kind` is
 * required on every node — legacy kind-less files are normalized once by the
 * store (no compatibility shim lives in the schema).
 */
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  WorkflowAgentNodeSchema,
  WorkflowTriggerNodeSchema,
]);

/**
 * A directed edge `from → to`, discriminated by `kind`. For `data` edges,
 * node `from`'s final text is appended to node `to`'s prompt context (`to`
 * depends on `from`; producers run first) — that is the geniro-app execution
 * semantics; the Geniro source models edges the other way around
 * (`edge.from` depends on `edge.to`), so the ported topo-sort operates on
 * this repo's producer→consumer direction. `call` edges order nothing and
 * feed nothing — they only grant the call_agent tool (see `EDGE_KINDS`).
 */
export const WorkflowEdgeSchema = z.object({
  from: z.string().min(1).describe('Source node id'),
  to: z.string().min(1).describe('Target node id'),
  kind: EdgeKindSchema.describe(
    "Edge kind — 'data' feeds output text; 'call' grants the call_agent tool",
  ),
  label: z.string().optional().describe('Optional edge label'),
});

/** Canvas position per node id — persisted so the canvas re-opens as drawn. */
export const WorkflowLayoutSchema = z.record(
  z.string(),
  z.object({ x: z.number(), y: z.number() }),
);

/** A complete workflow definition as stored in a `*.geniro.yaml` file. */
export const WorkflowSchema = z.object({
  name: z.string().min(1).describe('Human-readable workflow name'),
  description: z.string().optional(),
  // An empty node list is a legal library draft (the builder starts from a
  // blank canvas); running one is rejected at run start (GRAPH_EMPTY).
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  layout: WorkflowLayoutSchema.optional(),
});

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowAgentNode = z.infer<typeof WorkflowAgentNodeSchema>;
export type WorkflowTriggerNode = z.infer<typeof WorkflowTriggerNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * A workflow as listed over the wire: `slug` is the library file name without
 * the `.geniro.yaml` suffix and is the stable id the UI runs/edits by. The
 * counts feed the library cards (nodes, connections, and the per-agent-kind
 * breakdown) so the renderer never has to fetch every full definition to draw
 * the list.
 */
export interface WorkflowSummary {
  slug: string;
  name: string;
  description: string | null;
  nodeCount: number;
  edgeCount: number;
  /**
   * Per-agent-kind node counts — only kinds actually present, ordered by
   * `WORKFLOW_AGENT_KINDS` so the card badges keep a stable order.
   */
  agentCounts: { kind: AgentKind; count: number }[];
  updatedAt: string;
}

/** One workflow definition addressed by its library slug. */
export interface WorkflowWire {
  slug: string;
  workflow: Workflow;
}

/** Per-node execution state projected to the wire (from `node_state` rows). */
export interface NodeStateWire {
  runId: string;
  nodeId: string;
  status: NodeStatus;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

// ── Agent-to-agent call runtime ─────────────────────────────────────────────
// The shared contract between the CallBroker (call semantics), the graph
// executor (callee-turn mechanics), and the MCP server (the wire surface).

/** How a caller wants its call to behave (the call_agent `mode` argument). */
export const CALL_MODES = ['sync', 'async', 'fire_and_forget'] as const;
export type CallMode = (typeof CALL_MODES)[number];

/** How one callee sub-turn ended, as the executor reports it to the broker. */
export interface CalleeTurnOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string | null;
  error: string | null;
  /**
   * The callee's CLI session id captured during this turn — the resume handle
   * a follow-up call passes as `thread` to CONTINUE the conversation. Null
   * when the adapter emitted no session event (the thread is not resumable).
   */
  sessionId: string | null;
}

/**
 * The envelope every call tool returns — NEVER bare text. A discriminated
 * union so an `ok` envelope always carries `result` and an `error` always
 * carries `error` — the illegal mixed shapes are unrepresentable. `result`
 * carries `{ call_id, agent, text }` for a settled call and
 * `{ call_id, agent, state }` for an accepted async/fire-and-forget start;
 * `error` is a machine-prefixed one-liner (`DEPTH_LIMIT: …`).
 *
 * The `question` arm (M4, the Q&A bridge): the callee raised a mid-turn
 * AskUserQuestion and is PARKED awaiting the caller — answer with
 * `answer_agent(call_id, answer)`, then collect the final result with
 * `await_agent(call_id)` (a sync call that parks becomes await-collectable).
 * Left unanswered, the call fails with `QUESTION_TIMEOUT`.
 */
export type CallEnvelope =
  | { status: 'ok'; result: unknown }
  | { status: 'error'; error: string }
  | {
      status: 'question';
      call_id: string;
      /** The callee node id the question came from. */
      agent: string;
      /** The question text (multi-question inputs join per line). */
      question: string;
      /** Option labels the callee offered (may be empty for free-form). */
      options: string[];
    };

/**
 * A callee's mid-turn question, handed from the executor's capture seam to
 * the broker's parking lot (broker owns SEMANTICS — TTL, ownership, the
 * question envelope; the executor owns MECHANICS — the two closures below).
 * `deliver` writes the caller's answer into the callee's stdin control
 * channel (allow + `updatedInput.response` — the probe-verified free-text
 * channel); `fail` cancels the parked callee turn (TTL / orphan drain).
 * `payload` is the raw AskUserQuestion input for the transcript row.
 */
export interface ParkQuestionInput {
  question: string;
  options: string[];
  payload: unknown;
  /** Test seam; the executor omits it (broker default applies). */
  ttlMs?: number;
  deliver(answer: string): boolean;
  fail(): void;
}

/**
 * Whether cursor-agent caller nodes can receive the call tools on THIS
 * machine — the cached verdict of the one-shot MCP-trust probe (headless
 * cursor-agent silently drops MCP servers it hasn't approved, so the only
 * honest answer comes from actually running one turn against an echo tool).
 * `unknown` = not probed yet this launch (no cursor caller ran, or the
 * binary version could not be read so the verdict is not disk-cacheable).
 */
export interface CursorCallsCapability {
  status: 'pass' | 'fail' | 'unknown';
  /** `cursor-agent --version` line the verdict is keyed by; null = unreadable. */
  version: string | null;
  /** Epoch ms of the probe that produced this verdict; null when `unknown`. */
  probedAt: number | null;
  /** One-liner for the builder warning / system item when status is not pass. */
  reason: string | null;
}

/** GET /v1/capabilities — machine-level feature availability the builder reads. */
export interface CapabilitiesWire {
  cursorCalls: CursorCallsCapability;
}

/**
 * What the graph executor exposes to the broker for one live run — the
 * capability seam. The broker owns call SEMANTICS (ids, caps, sync/async
 * bookkeeping); the executor owns MECHANICS (spawning the callee turn,
 * transcript persistence, slot accounting, cancellation fan-out).
 */
export interface RunCallCapability {
  /** Callees each caller may invoke: caller node id → callee agent nodes. */
  readonly calleesOf: ReadonlyMap<string, readonly WorkflowAgentNode[]>;
  /**
   * Spawn one callee turn; resolves once the turn fully settles.
   * `depth` is the call's chain depth (1 = a top-level caller's callee): the
   * executor bounds only depth-1 turns with its sub-turn slot pool, so a
   * nested sync chain can't hold every slot while blocked on a deeper call.
   * `resumeSessionId` continues a prior callee CLI session (a thread
   * continuation); null starts a fresh conversation.
   */
  launchCalleeTurn(
    callee: WorkflowAgentNode,
    message: string,
    callId: string,
    depth: number,
    resumeSessionId: string | null,
  ): Promise<CalleeTurnOutcome>;
  /** Persist one transcript item on the run's serialized write chain. */
  persistItem(
    nodeId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): void;
  /** True once the run's cancel was requested — refuse new calls. */
  isCancelled(): boolean;
  /**
   * True while the node has at least one live turn — i.e. it could still
   * call answer_agent. A question parking after its owner settled (or owned
   * by a fire-and-forget caller) is orphaned immediately instead of waiting
   * out the TTL.
   */
  isNodeLive(nodeId: string): boolean;
}
