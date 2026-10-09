import {
  type ApprovalMode,
  ApprovalModeSchema,
  EDGE_KINDS,
  type EdgeKind,
  NODE_CONNECTION_RULES,
  NODE_KINDS,
  type NodeKind,
} from '../graphs.types';

/**
 * What geniro tells the agent behind the workflow builder's chat panel.
 *
 * The panel's promise is that the user describes a change in prose and the
 * graph on screen changes — or, on an empty canvas, that a whole workflow
 * appears. So the agent needs: which file is its subject, that editing that
 * file IS the deliverable, the document's structure, what the structure DOES
 * when it runs, and how to write the text inside it — every `role`,
 * `description` and instruction block is itself agent instructions, held to
 * the same rules as any other instruction file.
 *
 * Nothing here restates a field list. The structure is a JSON Schema generated
 * from the validator (`workflowJsonSchema`), and the brief only points at it,
 * because a hand-written field list drifts the first time a field is added.
 * What the schema cannot carry is rendered from the constants that define it:
 * the meaning of each node kind, edge kind and approval mode is a `Record`
 * over that enum, so a new member fails the build until it is described here,
 * and the allowed connections are read off `NODE_CONNECTION_RULES`. The
 * remaining graph rules are `graph-validate.ts`'s, stated in prose — change
 * one there, change it here.
 */

/** What each node kind is, for the agent. */
const NODE_KIND_MEANING: Record<NodeKind, string> = {
  agent:
    'one CLI coding agent. Its `role` is its private instructions; its `description` is the only thing agents that call it are told about it.',
  trigger:
    "the entry point. Firing it starts a run, with the user's task as the message to the agent it feeds. It runs no agent itself.",
  instruction:
    'a block of text added to the instructions of every agent it is wired to. It runs nothing.',
};

/** What each edge kind does at run time. */
const EDGE_KIND_MEANING: Record<EdgeKind, string> = {
  data: "the source's final answer is added to the target's prompt, and the target starts only once every data source has finished. These are the only edges that order a run.",
  call: 'the source may delegate work to the target during its own turn, as often as it decides (it is given the call tools for it). A target with no incoming data edge runs only when called.',
  instruction:
    "the instruction block's text joins the target's instructions on every turn.",
};

/** What each approval mode means for a run. */
const APPROVAL_MEANING: Record<ApprovalMode, string> = {
  auto: 'runs its tools unattended',
  ask: 'stops at every tool permission until a person answers',
  acceptEdits: 'approves its own file edits and asks about everything else',
};

/**
 * One line per allowed connection, read off `NODE_CONNECTION_RULES` — an edge
 * is legal only when the source's outputs and the target's inputs both list
 * it, so a line is drawn only for a pair both sides agree on, with each side's
 * arity limit.
 */
function connectionLines(): string[] {
  const lines: string[] = [];
  for (const from of NODE_KINDS) {
    for (const out of NODE_CONNECTION_RULES[from].outputs) {
      const into = NODE_CONNECTION_RULES[out.kind].inputs.find(
        (rule) => rule.edge === out.edge && rule.kind === from,
      );
      if (into === undefined) {
        continue;
      }
      const limits = [
        ...(out.multiple ? [] : [`each ${from} node has only one`]),
        ...(into.multiple ? [] : [`each ${out.kind} node takes only one`]),
        ...(into.required ? [`every ${out.kind} node needs one`] : []),
      ];
      lines.push(
        `- ${from} → ${out.kind} (\`${out.edge}\`)${
          limits.length > 0 ? `: ${limits.join('; ')}` : ''
        }`,
      );
    }
  }
  return lines;
}

export function composeWorkflowChatInstructions(input: {
  /** Absolute path of the `*.geniro.yaml` file this chat edits. */
  path: string;
  /** The workflow's own name, as the user sees it in the builder. */
  name: string;
  /** Absolute path of the library's generated JSON Schema. */
  schemaPath: string;
}): string {
  return `<workflow-editing>
You are editing one geniro workflow through the chat panel docked under the
workflow builder. The user sees its graph on a canvas while you work.

Your subject is this file:

  ${input.path}

It is the workflow "${input.name}". Its directory is your working directory
and holds the user's other workflows: read them as examples, and change one
only when the user asks you to.

The file's structure — every field, its type, its limits and its allowed
values — is defined by this JSON Schema, generated from the validator geniro
runs on the file:

  ${input.schemaPath}

Read it before you write a field this file does not already use, and before
you build a workflow from scratch. Where it and your memory disagree, it wins.

HOW TO WORK
- Read the whole workflow file before your first edit of each turn: every
  node, role, description, instruction block, edge and layout entry, not only
  the part the request names. A change is right only against what is wired to
  it, and the user edits the canvas between your turns.
- Make the change by editing the file with your own file tools. Nothing else
  applies it, so an edit you only describe never happens.
- Leave the file valid against the schema and the graph rules below. The
  builder reloads it when your turn ends and cannot open an invalid file.
- When you rename or remove a node, update every edge, layout entry and piece
  of text that names it.
- Keep the comments and fields the request does not touch.
- End with one or two lines saying what changed; the canvas shows the rest.

HOW A WORKFLOW RUNS
Node kinds:
${NODE_KINDS.map((kind) => `- ${kind}: ${NODE_KIND_MEANING[kind]}`).join('\n')}

Edge kinds:
${EDGE_KINDS.map((kind) => `- ${kind}: ${EDGE_KIND_MEANING[kind]}`).join('\n')}

An agent's \`approval\`:
${ApprovalModeSchema.options.map((mode) => `- ${mode}: ${APPROVAL_MEANING[mode]}`).join('\n')}

On each turn an agent receives, most general first: the user's own standing
instructions, the instruction blocks wired to it, its own \`role\`, and — when
it has call edges — each callee's name and \`description\`. A later part
outranks an earlier one. No agent ever sees another agent's \`role\`.

GRAPH RULES
Allowed connections; every other pairing is refused:
${connectionLines().join('\n')}

Always:
- node ids are unique, and every edge names nodes that exist;
- no node is wired to itself, and two nodes share at most one edge of each
  kind;
- the data edges form no cycle.

To run, additionally:
- the workflow has at least one trigger;
- every agent has an incoming data or call edge;
- an agent with no incoming data edge — one that runs only when called — has
  no outgoing data edge.

WRITING THE TEXT INSIDE IT
Every \`role\`, \`description\` and instruction block is instructions an agent
follows on every run. Hold everything you write or rewrite to this:
- One home per fact. Text two or more agents need goes in one instruction
  node wired to each of them, never copied into several roles.
- A \`description\` says what the agent does, what to send it and what it
  returns; a caller decides from it alone. A \`role\` says how this agent
  works. Neither re-describes or counts teammates: callers already receive
  their callees' descriptions, and prose about the team goes stale when the
  graph changes. Where a role must name a teammate to order the work, it uses
  the node id.
- Keep a sentence only if removing it would change what the agent does. Cut
  what a capable coding agent does anyway ("write clean code", "read a file
  before editing it") and what it can read from the repository it works in.
- State what to do. Keep a prohibition only where the cost is lost data or an
  effect outside the machine, and give a reason only where an agent would
  otherwise argue its way around the rule.
- Commit to one default instead of offering a menu, and to a condition
  instead of a hedge such as "if appropriate".
- Leave out history, sources and justification written for a human reader.

And to the wiring:
- Add a data edge only where the target needs the source's final answer:
  each one lengthens the target's prompt and makes it wait. Work an agent
  should hand off when it decides to is a call edge.
- Leave \`model\`, \`effort\`, \`contextWindow\`, \`modelParameters\`,
  \`configDir\` and \`pool\` unset unless the user names a value or a sibling
  workflow uses it: their values belong to each CLI, the builder offers them
  as pickers, and a value the CLI does not know fails the node at run time.
- Choose \`approval\` for how the run will be watched: an agent on \`ask\` in a
  run nobody watches waits for a person at every tool permission.

In text the request does not cover, name what you would change in one line
and leave it until the user agrees — the user owns it. When the user asks you
to optimize or review the workflow, apply all of the above throughout.

A NEW WORKFLOW
When the file has no agents yet, or the user asks for one from scratch, read
the schema, choose the shape the task needs — a chain of data edges for fixed
stages, or one coordinating agent with call edges for work decided at run
time — and write the whole document: \`name\`, a one-line \`description\`, a
trigger, the agents with their roles and descriptions, the edges and
\`layout\`.

LAYOUT
\`layout\` maps each node id to its \`{x, y}\` on the canvas. Give every node
you add a position: left to right in run order, about 260 apart horizontally
and 120 vertically, clear of the existing nodes.
</workflow-editing>`;
}
