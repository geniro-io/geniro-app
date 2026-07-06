import type { CliKind, EdgeKind, NodeKind } from '../../shared/contracts';
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
      description:
        'CLI agent that runs this node — fixed by the palette tile it was added from.',
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
 * Model choices offered per CLI agent in the inspector — the aliases each
 * CLI's own `--model` help documents (claude: aliases resolving to the latest
 * model of each tier; cursor-agent: the ids its help lists). Not exhaustive
 * by design: an empty model means the CLI's default, and any full model id
 * goes through the inspector's Custom entry, so this list never gates what
 * `--model` can receive.
 */
export const AGENT_MODEL_OPTIONS: Record<CliKind, readonly string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  'cursor-agent': ['gpt-5', 'sonnet-4', 'sonnet-4-thinking'],
};

/**
 * One typed connection rule (mirrors the daemon's `ConnectionRule` in
 * graphs.types.ts, plus a `description` for the info popup): "this side of a
 * node of some kind accepts/produces edges to nodes of `kind`". `required` =
 * the graph is invalid until such an edge exists; `multiple` = more than one
 * may attach (default: single).
 */
export interface ConnectionRule {
  /** Edge kind this rule governs — data-flow and call wires are separate ports. */
  edge: EdgeKind;
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
 *
 * Order matters: the FIRST rule per side is the painted top of the collapsed
 * handle stack (node-ports), so a collapsed drag lands on it — keep a data
 * rule first on every side, or collapsed drags stop being data-flow.
 */
export const NODE_CONNECTION_RULES: Record<
  NodeKind,
  { inputs: readonly ConnectionRule[]; outputs: readonly ConnectionRule[] }
> = {
  agent: {
    inputs: [
      {
        edge: 'data',
        kind: 'agent',
        multiple: true,
        description:
          "the final text of every upstream agent is appended to this node's prompt.",
      },
      {
        edge: 'data',
        kind: 'trigger',
        description:
          'fires this node with the run prompt — every run enters through a trigger.',
      },
      {
        edge: 'call',
        kind: 'agent',
        multiple: true,
        description:
          'agents wired here may invoke this node on demand during a run.',
      },
    ],
    outputs: [
      {
        edge: 'data',
        kind: 'agent',
        multiple: true,
        description:
          "this node's final text feeds every downstream agent it connects to.",
      },
      {
        edge: 'call',
        kind: 'agent',
        multiple: true,
        description:
          'this node may invoke the connected agents via the call_agent tool.',
      },
    ],
  },
  trigger: {
    // Triggers are pure entry points: nothing may feed one, and firing fans
    // out to any number of agents. Call wires never touch triggers.
    inputs: [],
    outputs: [
      {
        edge: 'data',
        kind: 'agent',
        multiple: true,
        description: 'fires the connected agents with the run prompt.',
      },
    ],
  },
};

/**
 * The React Flow handle id for one connection rule — geniro's
 * `${dir}-${rule.type}-${slug(rule.value)}` scheme extended with the edge
 * kind. Every rule renders its own handle under this id (collapsed and
 * expanded alike), and because the registry holds at most ONE rule per
 * (side, edge kind, peer kind), an edge's handles are fully derivable from
 * its kind + endpoint kinds — so ports never need to be persisted in the
 * YAML (which is also why this rename was free: handles never hit disk).
 */
export function makeHandleId(
  dir: 'source' | 'target',
  edge: EdgeKind,
  kind: NodeKind,
): string {
  return `${dir}-${edge}-${kind}`;
}

/**
 * The canvas edge ⇄ EdgeKind discriminator, in ONE place: a call edge
 * carries React Flow `type: 'call'` (which also renders it through the
 * registered call component); a data edge carries no type (React Flow's
 * default). Every canvas producer/consumer routes through this pair —
 * re-deriving the mapping inline is how a rename silently misses a site.
 */
export function flowEdgeKind(edge: { type?: string }): EdgeKind {
  return edge.type === 'call' ? 'call' : 'data';
}

/** Spreadable inverse of {@link flowEdgeKind} for building canvas edges. */
export function flowEdgeType(edgeKind: EdgeKind): { type?: 'call' } {
  return edgeKind === 'call' ? { type: 'call' } : {};
}

/**
 * The edge kind a drag is wiring, read off the handles it grabbed: a call
 * handle on EITHER end makes it a call wire (the other end may be a collapsed
 * stack's data handle — onConnect normalizes the pair afterwards). Everything
 * else — collapsed pills, missing handle ids — stays data flow, which is what
 * makes the collapsed-drag-is-data-flow rule hold.
 */
export function connectionEdgeKind(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
): EdgeKind {
  const edgeOf = (handle: string | null | undefined): string | undefined =>
    handle?.split('-')[1];
  return edgeOf(sourceHandle) === 'call' || edgeOf(targetHandle) === 'call'
    ? 'call'
    : 'data';
}

/**
 * Whether an edge of `edge` kind `source → target` is legal under the
 * connection rules: the source kind must list (edge, target kind) in its
 * `outputs` AND the target kind must list (edge, source kind) in its
 * `inputs` (both sides agree) — the same pairing the daemon's
 * `validateEdgeRules` enforces on save. Unknown kinds refuse the connection
 * rather than throwing: on the canvas this is a live drag predicate, not a
 * validation gate.
 */
export function canConnect(
  edgeKind: EdgeKind,
  sourceKind: string,
  targetKind: string,
  rules: Record<
    string,
    {
      inputs: readonly { edge: string; kind: string }[];
      outputs: readonly { edge: string; kind: string }[];
    }
  > = NODE_CONNECTION_RULES,
): boolean {
  const out = rules[sourceKind]?.outputs.some(
    (r) => r.edge === edgeKind && r.kind === targetKind,
  );
  const inp = rules[targetKind]?.inputs.some(
    (r) => r.edge === edgeKind && r.kind === sourceKind,
  );
  return Boolean(out && inp);
}
