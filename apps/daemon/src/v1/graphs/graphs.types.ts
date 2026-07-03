import { z } from 'zod';

import type { AgentKind, NodeStatus } from '../runs/runs.types';

/**
 * The workflow domain model — the zod half of the Geniro graph-core port
 * (geniro apps/api graphs.types.ts:134-167), trimmed to geniro-app's node
 * shape: every M3 node is a CLI coding agent (no runtime/tool/trigger node
 * kinds), so the node schema carries agent/model/role/approval instead of the
 * template+config indirection. YAML files (`*.geniro.yaml`) are the source of
 * truth for these shapes; SQLite stores runtime/history only.
 */

/** Agent kinds a node may run — kept in lockstep with `AgentKind`. */
export const WORKFLOW_AGENT_KINDS = ['claude', 'cursor-agent'] as const;

/** Compile-time check that the zod enum stays aligned with `AgentKind`. */
const _agentKindLockstep: readonly AgentKind[] = WORKFLOW_AGENT_KINDS;
void _agentKindLockstep;

/**
 * Per-node approval mode: `auto` lets the agent run its tools unattended;
 * `ask` routes tool-permission requests to the renderer as elicitation cards
 * and blocks the tool call until a verdict comes back.
 */
export const ApprovalModeSchema = z.enum(['auto', 'ask']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** One agent node of a workflow DAG. */
export const WorkflowNodeSchema = z.object({
  id: z.string().min(1).describe('Unique node id within the workflow'),
  name: z.string().min(1).optional().describe('Display name (defaults to id)'),
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
 * A directed edge `from → to`: node `from`'s final text is appended to node
 * `to`'s prompt context (`to` depends on `from`; producers run first). This is
 * the geniro-app execution semantics — the Geniro source models edges the
 * other way around (`edge.from` depends on `edge.to`), so the ported
 * topo-sort operates on this repo's producer→consumer direction.
 */
export const WorkflowEdgeSchema = z.object({
  from: z.string().min(1).describe('Producer node id'),
  to: z.string().min(1).describe('Consumer node id'),
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
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema).default([]),
  layout: WorkflowLayoutSchema.optional(),
});

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * A workflow as listed over the wire: `slug` is the library file name without
 * the `.geniro.yaml` suffix and is the stable id the UI runs/edits by.
 */
export interface WorkflowSummary {
  slug: string;
  name: string;
  description: string | null;
  nodeCount: number;
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
