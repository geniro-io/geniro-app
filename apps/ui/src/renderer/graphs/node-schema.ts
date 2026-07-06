import type { NodeKind } from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';

/**
 * The node schemas per kind — the renderer-side descriptor of the daemon's
 * `WorkflowNodeSchema` union (apps/daemon/src/v1/graphs/graphs.types.ts),
 * kept in lockstep by hand like the wire types in `shared/contracts.ts`.
 * Every kind shares the same ENVELOPE (id, kind, name); the kind-specific
 * fields follow. Per-CLI quirks (e.g. cursor-agent ignoring `approval: ask`)
 * stay in that agent's details bullets, never as a diverged schema.
 */
export interface NodeSchemaField {
  key: string;
  type: string;
  required: boolean;
  description: string;
}

/** Envelope fields every node kind shares. */
const ENVELOPE_FIELDS: readonly NodeSchemaField[] = [
  {
    key: 'id',
    type: 'string',
    required: true,
    description: 'Unique node id within the workflow (auto-generated).',
  },
  {
    key: 'kind',
    type: 'agent | trigger',
    required: true,
    description: 'Node kind — selects the fields below and connection rules.',
  },
  {
    key: 'name',
    type: 'string',
    required: false,
    description: 'Display name shown on the node (defaults to the id).',
  },
];

export const NODE_TYPE_SCHEMAS: Record<NodeKind, readonly NodeSchemaField[]> = {
  agent: [
    ...ENVELOPE_FIELDS,
    {
      key: 'agent',
      type: CLI_KINDS.join(' | '),
      required: true,
      description: 'CLI agent that runs this node.',
    },
    {
      key: 'model',
      type: 'string',
      required: false,
      description: 'Model alias; empty = the CLI default.',
    },
    {
      key: 'role',
      type: 'string',
      required: false,
      description: 'Role / system prompt prepended to the node turn.',
    },
    {
      key: 'approval',
      type: 'auto | ask',
      required: false,
      description: 'Tool-approval mode (defaults to auto).',
    },
  ],
  trigger: [
    ...ENVELOPE_FIELDS,
    {
      key: 'trigger',
      type: 'manual',
      required: true,
      description:
        'How this trigger fires — manual: you submit the run prompt by hand.',
    },
  ],
};

/**
 * One typed connection rule (mirrors the daemon's `ConnectionRule` in
 * graphs.types.ts, plus a `description` for the info popup): "this side of a
 * node of some kind accepts/produces edges to nodes of `kind`". `required` =
 * the graph is invalid until such an edge exists; `multiple` = more than one
 * may attach (default: single).
 */
export interface ConnectionRule {
  kind: NodeKind;
  required?: boolean;
  multiple?: boolean;
  description: string;
}

/**
 * The connection contract per node kind — the renderer mirror of the
 * daemon's `NODE_CONNECTION_RULES` (which enforces it on save/run). Drives
 * the info popup's Inputs/Outputs sections and the canvas
 * `isValidConnection`. A future kind is one new entry here + one in the
 * daemon registry.
 */
export const NODE_CONNECTION_RULES: Record<
  NodeKind,
  { inputs: readonly ConnectionRule[]; outputs: readonly ConnectionRule[] }
> = {
  agent: {
    inputs: [
      {
        kind: 'agent',
        multiple: true,
        description:
          "the final text of every upstream agent is appended to this node's prompt.",
      },
      {
        kind: 'trigger',
        description:
          'fires this node with the run prompt — every run enters through a trigger.',
      },
    ],
    outputs: [
      {
        kind: 'agent',
        multiple: true,
        description:
          "this node's final text feeds every downstream agent it connects to.",
      },
    ],
  },
  trigger: {
    inputs: [],
    outputs: [
      {
        kind: 'agent',
        multiple: true,
        description: 'fires the connected agents with the run prompt.',
      },
    ],
  },
};

/**
 * The React Flow handle id for one connection rule — geniro's
 * `${dir}-${rule.type}-${slug(rule.value)}` scheme collapsed to our kind-only
 * rules. Every rule renders its own handle under this id (collapsed and
 * expanded alike), and because the registry holds at most ONE rule per
 * (side, peer kind), an edge's handles are fully derivable from its endpoint
 * kinds — so ports never need to be persisted in the YAML.
 */
export function makeHandleId(dir: 'source' | 'target', kind: NodeKind): string {
  return `${dir}-kind-${kind}`;
}

/**
 * Whether an edge `source → target` is legal under the connection rules:
 * the source kind must list the target kind in its `outputs` AND the target
 * kind must list the source kind in its `inputs` (both sides agree) — the
 * same pairing the daemon's `validateEdgeRules` enforces on save. Unknown
 * kinds refuse the connection rather than throwing: on the canvas this is a
 * live drag predicate, not a validation gate.
 */
export function canConnect(
  sourceKind: string,
  targetKind: string,
  rules: Record<
    string,
    {
      inputs: readonly { kind: string }[];
      outputs: readonly { kind: string }[];
    }
  > = NODE_CONNECTION_RULES,
): boolean {
  const out = rules[sourceKind]?.outputs.some((r) => r.kind === targetKind);
  const inp = rules[targetKind]?.inputs.some((r) => r.kind === sourceKind);
  return Boolean(out && inp);
}
