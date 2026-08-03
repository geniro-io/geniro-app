import { z } from 'zod';

import { ClaudeModesCapabilitySchema } from '../agents/chat.types';
import {
  AgentKindSchema,
  type ItemKind,
  NodeStatusSchema,
} from '../runs/runs.types';

/**
 * The workflow domain model — the zod half of the Geniro graph-core port
 * (geniro apps/api graphs.types.ts:134-167), trimmed to geniro-app's node
 * shapes: a `kind`-discriminated union of agent nodes (CLI coding agents
 * carrying agent/model/role/approval — no template+config indirection) and
 * trigger nodes (the graph's entry points, geniro-style: a run fires a
 * trigger, never an agent directly). YAML files (`*.geniro.yaml`) are the
 * source of truth for these shapes; SQLite stores runtime/history only.
 */

/**
 * Agent kinds a node may run — the same enum the runs domain uses, re-exported
 * under the graph vocabulary so a node schema and a run row can never drift.
 */
export const WORKFLOW_AGENT_KINDS = AgentKindSchema.options;

/**
 * Node kinds a workflow may contain. A new kind is added here plus one entry
 * in `NODE_CONNECTION_RULES` (and its schema branch in `WorkflowNodeSchema`)
 * — nothing else has to change for the graph validation and the builder to
 * understand it.
 */
export const NODE_KINDS = ['agent', 'trigger'] as const;
export const NodeKindSchema = z.enum(NODE_KINDS).meta({ id: 'NodeKind' });
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Trigger types a trigger node may carry — `manual` (fired by hand) today. */
export const TRIGGER_KINDS = ['manual'] as const;
export const TriggerKindSchema = z
  .enum(TRIGGER_KINDS)
  .meta({ id: 'TriggerKind' });
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

/**
 * Edge kinds: `data` — the producer's final text feeds the consumer's prompt
 * (the DAG flow); `call` — the source may invoke the target at runtime via
 * the call_agent tool (grants permission only; no data flows along it).
 */
export const EDGE_KINDS = ['data', 'call'] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS).meta({ id: 'EdgeKind' });
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
 * and blocks the tool call until a verdict comes back; `acceptEdits`
 * auto-approves file edits on the CLI side and routes everything else to the
 * `ask` card path. `plan` is deliberately absent — it is chat-only
 * (CHAT_APPROVAL_MODES in v1/agents/chat.types.ts). NOTE: widening this enum
 * is a one-way door — narrowing it back silently drops saved YAML workflows
 * carrying the removed value from the library listing (workflow-store skips
 * unparseable files).
 */
export const ApprovalModeSchema = z
  .enum(['auto', 'ask', 'acceptEdits'])
  .meta({ id: 'ApprovalMode' });
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** Envelope fields every node kind shares. */
const workflowNodeBase = {
  id: z.string().min(1).describe('Unique node id within the workflow'),
  name: z.string().min(1).optional().describe('Display name (defaults to id)'),
};

/** One agent node — a CLI coding agent running one turn per run. */
export const WorkflowAgentNodeSchema = z
  .object({
    ...workflowNodeBase,
    kind: z.literal('agent'),
    agent: AgentKindSchema.describe('CLI agent that runs this node'),
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Model alias; omitted = CLI default'),
    /**
     * The node's PUBLIC blurb: what this agent is for, written for the agents
     * wired to call it. It is the only thing a caller is told about a callee
     * (see `calleeSummary`) — it rides the call_agent tool description and the
     * caller's "May call" block, so a caller discovers its team from the graph
     * instead of restating it in its own role.
     */
    description: z
      .string()
      .optional()
      .describe('What this agent does — shown to agents wired to call it'),
    /**
     * The node's PRIVATE instructions, prepended to its own turn and never
     * shown to another node. Keeping role private is the point: a callee's
     * internals (which skills it runs, how it works) are its own business.
     */
    role: z
      .string()
      .optional()
      .describe('Role/system prompt prepended to the node turn'),
    approval: ApprovalModeSchema.describe('Tool-approval mode for this node'),
    /**
     * A plugin directory this node's turns load, and no other node's.
     *
     * A plugin may ship its own MCP servers, so two nodes pointed at different
     * directories genuinely run with different tools — which is the whole
     * reason this is a NODE field rather than a run-level one. It is loaded
     * for the session only; nothing is installed and no user config is
     * written.
     *
     * Absolute path, validated before it reaches argv. The CLI silently
     * ignores a path it cannot use (probe-verified: a missing directory, a
     * plugin-less one and a plain file all exit 0 reporting no servers), so a
     * typo would otherwise present as "this node has no MCP servers" —
     * indistinguishable from the truth.
     */
    pluginDir: z
      .string()
      .min(1)
      .optional()
      .describe('Absolute path to a plugin directory loaded for this node'),
  })
  .meta({ id: 'WorkflowAgentNode' });

/**
 * One trigger node — the graph's entry point. It runs no CLI: firing it
 * (today only `manual` — submitting a run prompt) seeds its downstream
 * agents. A run refuses to start unless every root node is a trigger.
 */
export const WorkflowTriggerNodeSchema = z
  .object({
    ...workflowNodeBase,
    kind: z.literal('trigger'),
    trigger: TriggerKindSchema.describe('How this trigger fires'),
  })
  .meta({ id: 'WorkflowTriggerNode' });

/**
 * One node of a workflow DAG, discriminated by `kind`. Strict: `kind` is
 * required on every node — legacy kind-less files are normalized once by the
 * store (no compatibility shim lives in the schema).
 */
export const WorkflowNodeSchema = z
  .discriminatedUnion('kind', [
    WorkflowAgentNodeSchema,
    WorkflowTriggerNodeSchema,
  ])
  .meta({ id: 'WorkflowNode' });

/**
 * A directed edge `from → to`, discriminated by `kind`. For `data` edges,
 * node `from`'s final text is appended to node `to`'s prompt context (`to`
 * depends on `from`; producers run first) — that is the geniro-app execution
 * semantics; the Geniro source models edges the other way around
 * (`edge.from` depends on `edge.to`), so the ported topo-sort operates on
 * this repo's producer→consumer direction. `call` edges order nothing and
 * feed nothing — they only grant the call_agent tool (see `EDGE_KINDS`).
 */
export const WorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).describe('Source node id'),
    to: z.string().min(1).describe('Target node id'),
    kind: EdgeKindSchema.describe(
      "Edge kind — 'data' feeds output text; 'call' grants the call_agent tool",
    ),
    label: z.string().optional().describe('Optional edge label'),
  })
  .meta({ id: 'WorkflowEdge' });

/** Canvas position per node id — persisted so the canvas re-opens as drawn. */
export const WorkflowLayoutSchema = z.record(
  z.string(),
  z.object({ x: z.number(), y: z.number() }).meta({ id: 'NodePosition' }),
);

/**
 * A complete workflow definition — the `*.geniro.yaml` shape and the HTTP wire
 * shape alike.
 *
 * Deliberately DEFAULT-FREE: a zod `.default()` makes a field optional on the
 * way in and required on the way out, so the schema would render as two
 * different OpenAPI components (a request one and a response one) and the
 * generated client would carry two incompatible `Workflow` types. Leniency for
 * hand-written YAML lives in {@link WorkflowYamlSchema}, which layers the
 * defaults back on for the file-parsing path only.
 */
export const WorkflowSchema = z
  .object({
    name: z.string().min(1).describe('Human-readable workflow name'),
    description: z.string().optional(),
    // An empty node list is a legal library draft (the builder starts from a
    // blank canvas); running one is rejected at run start (GRAPH_EMPTY).
    nodes: z.array(WorkflowNodeSchema),
    edges: z.array(WorkflowEdgeSchema),
    layout: WorkflowLayoutSchema.optional(),
  })
  .meta({ id: 'Workflow' });

/**
 * {@link WorkflowSchema} with the omissible-in-YAML fields defaulted — the ONE
 * schema `parseWorkflowYaml` reads files through, so a hand-written workflow
 * may still leave `nodes`/`edges` off a draft and `approval`/`trigger` off a
 * node. Derived from the strict schemas (never a second copy of the shapes), so
 * a field added above is automatically accepted here too; parsing yields the
 * strict `Workflow` type because zod applies the defaults.
 */
export const WorkflowYamlSchema = WorkflowSchema.extend({
  nodes: z
    .array(
      z.discriminatedUnion('kind', [
        WorkflowAgentNodeSchema.extend({
          approval: ApprovalModeSchema.default('auto'),
        }),
        WorkflowTriggerNodeSchema.extend({
          trigger: TriggerKindSchema.default('manual'),
        }),
      ]),
    )
    .default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
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
export const WorkflowSummarySchema = z.object({
  slug: z
    .string()
    .describe('Library file name without the .geniro.yaml suffix'),
  name: z.string(),
  description: z.string().nullable(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  /**
   * Per-agent-kind node counts — only kinds actually present, ordered by
   * `WORKFLOW_AGENT_KINDS` so the card badges keep a stable order.
   */
  agentCounts: z
    .array(
      z
        .object({ kind: AgentKindSchema, count: z.number().int() })
        .meta({ id: 'AgentCount' }),
    )
    .describe('Per-agent-kind node counts, only kinds present, stable order'),
  updatedAt: z.string(),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

/** One workflow definition addressed by its library slug. */
export const WorkflowWireSchema = z.object({
  slug: z.string(),
  workflow: WorkflowSchema,
});
export type WorkflowWire = z.infer<typeof WorkflowWireSchema>;

/** Per-node execution state projected to the wire (from `node_state` rows). */
export const NodeStateWireSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  status: NodeStatusSchema,
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type NodeStateWire = z.infer<typeof NodeStateWireSchema>;

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

/** GET /v1/capabilities — machine-level feature availability the builder reads. */
export const CapabilitiesWireSchema = z.object({
  claudeModes: ClaudeModesCapabilitySchema.describe(
    'Claude permission-mode probe verdict (acceptEdits / plan support)',
  ),
});
export type CapabilitiesWire = z.infer<typeof CapabilitiesWireSchema>;

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
