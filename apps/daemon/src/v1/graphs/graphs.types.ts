import { z } from 'zod';

import {
  ChatApprovalModeSchema,
  ClaudeModesCapabilitySchema,
  CustomInstructionsSchema,
} from '../agents/chat.types';
import {
  AgentKindSchema,
  type ItemKind,
  NodeStatusSchema,
} from '../runs/runs.types';

/**
 * The workflow domain model — the zod half of the Geniro graph-core port
 * (geniro apps/api graphs.types.ts:134-167), trimmed to geniro-app's node
 * shapes: a `kind`-discriminated union of agent nodes (CLI coding agents
 * carrying agent/model/role/approval — no template+config indirection),
 * trigger nodes (the graph's entry points, geniro-style: a run fires a
 * trigger, never an agent directly) and instruction nodes (free-text blocks
 * wired to the agents they apply to, which run nothing themselves). YAML
 * files (`*.geniro.yaml`) are the source of truth for these shapes; SQLite
 * stores runtime/history only.
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
export const NODE_KINDS = ['agent', 'trigger', 'instruction'] as const;
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
 * the call_agent tool (grants permission only; no data flows along it);
 * `instruction` — the source instruction block's text is appended to the
 * target's turn instructions (no data flows and nothing is ordered, the same
 * way a `call` edge orders nothing).
 *
 * Only `data` participates in the DAG: `buildEdgeMaps` and `computeRunOrder`
 * ignore everything else, which is what lets an instruction block attach to a
 * node without becoming one of its producers.
 */
export const EDGE_KINDS = ['data', 'call', 'instruction'] as const;
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
      { edge: 'instruction', kind: 'instruction', multiple: true },
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
  instruction: {
    // An instruction block is written, never produced: nothing may feed one,
    // and it only ever hands its text to agents. Data and call wires never
    // touch it — it runs no CLI and has no output to order.
    inputs: [],
    outputs: [{ edge: 'instruction', kind: 'agent', multiple: true }],
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
     * How hard this node's CLI is asked to think, in that CLI's own vocabulary
     * (`AgentAdapter.listEfforts`) — never an enum here, for the same reason
     * `model` is a free string: the levels belong to the CLI, and a CLI that
     * gains one must not need an app release to offer it.
     *
     * A level the node's CLI does not list is DROPPED at run start with a
     * system item naming it, exactly as an unusable `configDir` is: the two
     * fail the same way (a workflow arriving as YAML carries a value the
     * builder never had a chance to refuse) and the cost of passing it through
     * differs per CLI — claude warns and runs on its default, cursor answers
     * `-32602` and the turn is lost.
     */
    effort: z
      .string()
      .min(1)
      .optional()
      .describe('Reasoning-effort level; omitted = CLI default'),
    /**
     * Which of the model's context-window sizes this node's turns run at, in
     * the CLI's own vocabulary (`300k`, `1m`); omitted = the model's own
     * default.
     *
     * Beside `effort` because it is the same kind of thing — a per-MODEL
     * parameter the adapter owns the vocabulary of — and it fails the same way:
     * a size the node's model does not offer is answered `-32602` by cursor,
     * so the turn's own driver reports it on the transcript rather than a
     * constant here refusing it at save time. A workflow runs for months and
     * its model's sizes can change under it, which is exactly why the check
     * belongs against the live agent.
     */
    contextWindow: z
      .string()
      .min(1)
      .optional()
      .describe("Context-window size; omitted = the model's own default"),
    /**
     * Every OTHER model setting this node's turns ask for, keyed by the CLI's
     * own parameter id (`{optimize_for: 'intelligence'}`).
     *
     * Unchecked here for the reason the window above is, taken further: geniro
     * holds no vocabulary for these at all — the model enumerates them and the
     * live agent refuses a value it does not accept, per turn, which is the
     * only check that stays true for a workflow that runs for months.
     */
    modelParameters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults",
      ),
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
     * The agent config directory this node's turns run under, and no other
     * node's — the folder holding that CLI's credentials, settings, installed
     * plugins and history.
     *
     * A NODE field rather than a run-level one because that is what it buys:
     * two nodes of one graph can run as different ACCOUNTS (two subscriptions,
     * two rate limits) with different tools, and neither touches the user's
     * default profile.
     *
     * Absolute path, validated before it reaches the child's env. Existence is
     * checked because the CLI will not check it: claude CREATES whatever
     * directory it is handed and reports "Not logged in" (probe-verified on
     * 2.1.227), so a typo would otherwise fail the node with a login error
     * about a profile nobody meant to name.
     */
    configDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute path to the agent config directory this node runs under',
      ),
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
 * One instruction block — free text wired to the agents it applies to.
 *
 * It is NOT an execution step: it runs no CLI, holds no slot, never enters the
 * run order and never settles. Each wired agent's turn is composed with this
 * text in it; `composeTurnInstructions` owns where it ranks against the user's
 * global instructions and that node's own `role`.
 */
export const WorkflowInstructionNodeSchema = z
  .object({
    ...workflowNodeBase,
    kind: z.literal('instruction'),
    /**
     * Bounded and control-character-free through the SAME schema the user's
     * global custom instructions use, because it reaches the same place: the
     * composed block that becomes claude's `--append-system-prompt` argv. A
     * NUL there makes `spawn` throw SYNCHRONOUSLY, and a workflow is a file
     * that can be IMPORTED, so the text is not necessarily written by the
     * person who runs it — the block would fail every wired node of every run,
     * with nothing on screen naming a character the builder renders as
     * nothing.
     *
     * It still admits the EMPTY string: a block is dropped on the canvas
     * before it is written, so refusing `''` would make a freshly-added node
     * unsaveable. The builder flags an empty one instead (`node-validate.ts`),
     * where it can be shown beside the field.
     */
    instructions: CustomInstructionsSchema.describe(
      'Instruction text appended to every wired agent’s turn',
    ),
  })
  .meta({ id: 'WorkflowInstructionNode' });

/**
 * One node of a workflow DAG, discriminated by `kind`. Strict: `kind` is
 * required on every node — legacy kind-less files are normalized once by the
 * store (no compatibility shim lives in the schema).
 */
export const WorkflowNodeSchema = z
  .discriminatedUnion('kind', [
    WorkflowAgentNodeSchema,
    WorkflowTriggerNodeSchema,
    WorkflowInstructionNodeSchema,
  ])
  .meta({ id: 'WorkflowNode' });

/**
 * A directed edge `from → to`, discriminated by `kind`. For `data` edges,
 * node `from`'s final text is appended to node `to`'s prompt context (`to`
 * depends on `from`; producers run first) — that is the geniro-app execution
 * semantics; the Geniro source models edges the other way around
 * (`edge.from` depends on `edge.to`), so the ported topo-sort operates on
 * this repo's producer→consumer direction. `call` and `instruction` edges
 * order nothing and feed no prompt context — the first grants the call_agent
 * tool, the second carries instruction text (see `EDGE_KINDS`).
 */
export const WorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).describe('Source node id'),
    to: z.string().min(1).describe('Target node id'),
    kind: EdgeKindSchema.describe(
      "Edge kind — 'data' feeds output text; 'call' grants the call_agent tool; 'instruction' appends instruction text",
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
        WorkflowInstructionNodeSchema.extend({
          // Leniency layered ON the bounded schema, never a fresh `z.string()`:
          // re-declaring the field here would silently drop its cap and its
          // control-character refusal for the ONE path that reads files from
          // disk — which is the only path a hostile workflow arrives by.
          //
          // `nullish`, not `.default()`: a hand-written `instructions:` with
          // nothing after it parses as NULL, which a default never fires for,
          // so the block a user scaffolded and had not filled in yet made its
          // whole workflow unopenable.
          instructions: CustomInstructionsSchema.nullish().transform(
            (value) => value ?? '',
          ),
        }),
      ]),
    )
    .default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
});

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowAgentNode = z.infer<typeof WorkflowAgentNodeSchema>;
export type WorkflowTriggerNode = z.infer<typeof WorkflowTriggerNodeSchema>;
export type WorkflowInstructionNode = z.infer<
  typeof WorkflowInstructionNodeSchema
>;
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
  /**
   * The node's last context reading and the window it was measured against —
   * what a client with no live plane draws its ring from. Null while the node
   * has reported none.
   */
  contextTokens: z.number().nullable(),
  contextWindowTokens: z.number().nullable(),
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

/**
 * The bounds on `await_agent`'s own `timeout_ms` — a model's argument, so they
 * are enforced where a model's arguments are (the MCP layer, as INVALID_ARGS)
 * rather than inside the broker.
 *
 * The CEILING is the load-bearing one and it is a MEASUREMENT of the transport
 * rather than a policy: a claude caller aborts its own HTTP fetch at ~338s
 * (`McpServerService.handlePost`), and a window past that could never be
 * observed — the socket closes first and the collection comes back
 * AWAIT_ABANDONED instead of the `pending` the caller asked for. 300s leaves
 * the margin. The floor is there so a `0` cannot be read as "block forever",
 * which is the one misreading that would silently reinstate the wait this
 * argument exists to bound.
 */
export const MIN_AWAIT_TIMEOUT_MS = 1_000;
export const MAX_AWAIT_TIMEOUT_MS = 300_000;

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
 *
 * The `pending` arm: `await_agent` was given a `timeout_ms` and the callee was
 * still working when it elapsed. It is NOT an outcome and NOT a failure — the
 * call is untouched and stays collectable, so the caller may go and do
 * something else and await again. It exists because the alternative shapes are
 * both worse: an `error` reads to a model as the call having gone wrong, and an
 * `ok` with no text reads as a callee that finished having said nothing.
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
    }
  | {
      status: 'pending';
      call_id: string;
      /** The callee node id still working on it. */
      agent: string;
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
 * Whether ONE CLI can be pointed at a different config directory — i.e. run an
 * invocation as a different account, under a different profile.
 *
 * The wire home for `AdapterConfig.configDir.unavailableReason`, which was the
 * daemon's single source of truth with no way to reach the renderer — so the
 * builder hardcoded its own `agent === 'claude'` allowlist, the executor
 * silently STRIPPED a `configDir` it could not honour, and the listing service
 * refused one with a 400. Three answers to one question, reachable today by
 * importing a workflow YAML. Carrying the adapter's own reason here is what
 * collapses them back to one.
 */
export const AgentConfigDirCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI cannot be given one, or null when it can. A SENTENCE rather
     * than a boolean, because the renderer shows it: "cannot" with no reason is
     * the silent refusal this replaced.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentConfigDirCapability' });
export type AgentConfigDirCapability = z.infer<
  typeof AgentConfigDirCapabilitySchema
>;

/**
 * Whether ONE CLI has an INTERACTIVE terminal mirror — a `--resume` session the
 * user can type at.
 *
 * The wire home for `AdapterConfig.terminal`, for exactly the reason the config-dir
 * row above exists: without it the renderer hardcodes `agent === 'claude'` to
 * decide whether to offer the mirror picker, and a second CLI gaining one (or
 * claude losing one) leaves the picker offering a choice the daemon answers
 * with TERMINAL_UNSUPPORTED.
 *
 * Note this says nothing about the LIVE mirror, which every agent has: it is
 * the raw stdio of whichever CLI ran the turn, so there is no per-CLI fact to
 * report.
 */
export const AgentTerminalCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI has no interactive terminal, or null when it has one. A
     * sentence for the same reason as the config-dir row: a bare "cannot" is the
     * silent refusal these capabilities exist to replace.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentTerminalCapability' });
export type AgentTerminalCapability = z.infer<
  typeof AgentTerminalCapabilitySchema
>;

/**
 * The tool-approval modes ONE CLI honours — the wire home for
 * `AdapterConfig.approval.modes`.
 *
 * It exists for the same reason as the two rows above, and after the same
 * failure: with no per-CLI answer on the wire, the composer's approval chip
 * hardcoded `agentKind === 'cursor-agent'` and rendered nothing, on the
 * (once-true, now false) grounds that the CLI had no per-turn approval
 * channel. ACP made `ask` and `acceptEdits` real, so the chip was hiding a
 * control the user genuinely has — every cursor chat sat in `ask`, raising a
 * permission card per tool, with no way to switch it off.
 *
 * A CLI that honours none reports an empty list, which is a fact the renderer
 * can act on rather than a name it has to recognize.
 */
export const AgentApprovalCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    modes: z
      .array(ChatApprovalModeSchema)
      .describe('Approval modes this CLI honours, in no particular order'),
  })
  .meta({ id: 'AgentApprovalCapability' });
export type AgentApprovalCapability = z.infer<
  typeof AgentApprovalCapabilitySchema
>;

/**
 * Whether ONE CLI can be handed a user message MID-TURN — the wire home for
 * `AdapterConfig.followUp`.
 *
 * It exists for the same reason as the three rows above, and after the same
 * failure in the same place: the composer's queue offers a "send now" that
 * pushes a queued message into the turn already running, and only claude has a
 * channel for one. Without this row the strip would have to decide by agent
 * name — or, worse, offer the control to every CLI and let the daemon answer
 * RUN_BUSY, which looks to the user like a button that does nothing.
 */
export const AgentFollowUpCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI cannot take a message into a running turn, or null when it
     * can. A sentence for the same reason as the rows above: the renderer puts
     * it on the disabled control, so the user learns their message is waiting
     * for the turn to end rather than being ignored.
     */
    unavailableReason: z.string().nullable(),
    /**
     * Whether delivering it STOPS what the agent is currently doing.
     *
     * The two shipped CLIs differ, so the control cannot describe itself from
     * one sentence: claude's message joins the turn and is picked up at the
     * next tool boundary, while a second `session/prompt` cancels cursor's
     * current work and answers the new message instead. The renderer says which
     * before the press, not after.
     */
    interrupts: z
      .boolean()
      .describe('Whether a mid-turn message stops what the agent is doing'),
  })
  .meta({ id: 'AgentFollowUpCapability' });
export type AgentFollowUpCapability = z.infer<
  typeof AgentFollowUpCapabilitySchema
>;

/** Whether one CLI reports the background sub-agents it runs. */
export const AgentSubagentCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI's delegates never appear, or null when it reports them.
     *
     * A sentence rather than a boolean because the renderer SHOWS it: a chat
     * that lists no sub-agents is otherwise indistinguishable from a bug, and
     * "cursor-agent reports no sub-agents over ACP" is the difference between
     * a missing feature and a missing signal.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentSubagentCapability' });
export type AgentSubagentCapability = z.infer<
  typeof AgentSubagentCapabilitySchema
>;

/**
 * Whether ONE CLI offers a reasoning-effort PICKER — the wire home for
 * `AdapterConfig.effortsUnavailableReason`.
 *
 * `GET /v1/agents/efforts` already answers `[]` for a CLI with no such control,
 * and `[]` is enough to hide the picker — but not enough to explain the chip
 * that replaces it. That gap is what got "I cannot change the effort of a Cursor
 * model" reported against a surface working exactly as measured: the composer
 * showed an inert `high` and the only cause was a hover tooltip the renderer had
 * written itself, behind an `agentKind === 'cursor-agent'` branch. This row is
 * the same iterate-never-list shape as the six above, and it carries the
 * adapter's own sentence — which names where the effort DOES change, the one
 * thing a refusal has to say to be worth reading.
 */
export const AgentModelEffortCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI offers no effort picker, or null when it does. A sentence for
     * the same reason as every row above: the renderer shows it verbatim.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentModelEffortCapability' });
export type AgentModelEffortCapability = z.infer<
  typeof AgentModelEffortCapabilitySchema
>;

/** Whether one CLI reports what a turn cost it in tokens and money. */
export const AgentUsageCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI's context meter is always empty, or null when it reports
     * usage.
     *
     * A sentence, and shown on the meter's own hover — because an empty spot
     * where a ring sits on the chat beside it is a question the user WILL ask,
     * and did. Unlike the sub-agent note this replaced the shape of, it has no
     * standing footprint: the meter says nothing until it is pointed at.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentUsageCapability' });
export type AgentUsageCapability = z.infer<typeof AgentUsageCapabilitySchema>;

/** GET /v1/capabilities — machine-level feature availability the builder reads. */
export const CapabilitiesWireSchema = z.object({
  claudeModes: ClaudeModesCapabilitySchema.describe(
    'Claude permission-mode probe verdict (acceptEdits / plan support)',
  ),
  configDirs: z
    .array(AgentConfigDirCapabilitySchema)
    .describe(
      'Per-CLI config-directory (profile / account) support, one entry per known agent',
    ),
  interactiveTerminals: z
    .array(AgentTerminalCapabilitySchema)
    .describe(
      'Per-CLI interactive terminal-mirror support, one entry per known agent',
    ),
  approvals: z
    .array(AgentApprovalCapabilitySchema)
    .describe('Per-CLI tool-approval modes, one entry per known agent'),
  followUps: z
    .array(AgentFollowUpCapabilitySchema)
    .describe('Per-CLI mid-turn follow-up support, one entry per known agent'),
  subagents: z
    .array(AgentSubagentCapabilitySchema)
    .describe(
      'Per-CLI background sub-agent reporting, one entry per known agent',
    ),
  usage: z
    .array(AgentUsageCapabilitySchema)
    .describe('Per-CLI token/cost usage reporting, one entry per known agent'),
  modelEfforts: z
    .array(AgentModelEffortCapabilitySchema)
    .describe(
      'Per-CLI reasoning-effort picker support, one entry per known agent',
    ),
  /**
   * The instruction block geniro prepends to EVERY user-facing turn, verbatim.
   *
   * Sent so the Settings screen can show the user what is already being said
   * on their behalf before their own instructions. It is served rather than
   * restated in the renderer for the usual reason: a second copy is a copy
   * that drifts, and this one would drift silently — nothing renders the text
   * a CLI actually received, so the preview would go on describing an older
   * preamble indefinitely.
   *
   * Not per-agent: both transports carry the same block (claude on
   * `--append-system-prompt`, ACP as leading prompt text), which is the point
   * of composing it at one seam.
   */
  hostPreamble: z
    .string()
    .describe(
      'The instruction block geniro prepends to every user-facing turn, before the user’s own custom instructions',
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
