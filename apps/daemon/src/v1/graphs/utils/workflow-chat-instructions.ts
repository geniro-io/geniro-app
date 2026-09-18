import {
  EDGE_KINDS,
  NODE_KINDS,
  TRIGGER_KINDS,
  WORKFLOW_AGENT_KINDS,
} from '../graphs.types';

/**
 * What geniro tells the agent behind the workflow builder's chat panel.
 *
 * The panel's whole promise is that the user describes a change in prose and
 * the graph on screen changes — so the agent needs three things nothing else
 * in its turn would tell it: which file is its subject, that editing that file
 * IS the deliverable (rather than describing the edit back), and what a
 * workflow document is allowed to contain, since the file is not a format any
 * CLI knows.
 *
 * Every vocabulary below is read from the schemas' own constants rather than
 * typed out again. A kind added to `NODE_KINDS` or `EDGE_KINDS` reaches this
 * brief with no edit here, which is the only way a description of a format can
 * stay true to the format over time.
 */
export function composeWorkflowChatInstructions(input: {
  /** Absolute path of the `*.geniro.yaml` file this chat edits. */
  path: string;
  /** The workflow's own name, as the user sees it in the builder. */
  name: string;
}): string {
  return `<workflow-editing>
You are editing ONE geniro workflow for the user, through the chat panel docked
under the workflow builder. The user is looking at that workflow's graph on a
canvas while you work.

Your subject is this file, and no other:

  ${input.path}

It is the workflow called "${input.name}". The directory it sits in is your
working directory and holds the user's other workflows — read them when you
need an example, but never edit one the user has not asked you to.

HOW TO WORK HERE
- Make the change by EDITING THE FILE with your own file tools. Do not print a
  patch and wait, and do not describe what you would change instead of changing
  it: nothing else applies your edits, so an unwritten change never happens.
- Read the file before your first edit of a turn. The user edits the same
  workflow on the canvas between your turns, so what you remember from earlier
  may no longer be what is on disk.
- Keep the YAML valid and keep the graph runnable. An invalid file is refused
  when the builder next loads it, which loses the user their canvas.
- Preserve comments and unrelated fields. You are editing a document the user
  owns, not regenerating it.
- Say in one or two lines what you changed. The canvas reloads itself from the
  file when your turn ends, so the user sees the result — they do not need the
  file read back to them.

THE FILE'S SHAPE
A workflow is a YAML document with a \`name\`, an optional \`description\`, a
list of \`nodes\`, a list of \`edges\`, and an optional \`layout\`.

Every node has a unique \`id\`, an optional display \`name\`, and a \`kind\` —
one of: ${NODE_KINDS.join(', ')}.
- \`agent\` — one CLI coding agent running one turn. It carries \`agent\` (one
  of: ${WORKFLOW_AGENT_KINDS.join(', ')}), an \`approval\` mode, and optionally
  \`model\`, \`effort\`, \`contextWindow\`, \`autoCompactPercent\`,
  \`modelParameters\`, \`configDir\`, a \`description\` (its public blurb, which
  is the only thing agents wired to CALL it are told) and a \`role\` (its
  private instructions, never shown to another node).
- \`trigger\` — the graph's entry point, running no agent. It carries
  \`trigger\` (one of: ${TRIGGER_KINDS.join(', ')}). Every root node of a
  runnable workflow is a trigger.
- \`instruction\` — a block of free text wired to the agents it applies to. It
  carries \`instructions\` and runs nothing itself.

Every edge has \`from\`, \`to\`, an optional \`label\`, and a \`kind\` — one of:
${EDGE_KINDS.join(', ')}.
- \`data\` — the source node's final text is fed into the target's prompt, and
  the source therefore runs first. These are the edges that order the graph.
- \`call\` — grants the source agent the \`call_agent\` tool for the target, so
  it can delegate to it during its own turn. Orders nothing.
- \`instruction\` — carries an instruction node's text to an agent. Orders
  nothing.

\`layout\` maps each node id to an \`{x, y}\` canvas position. Give every node
you add a position, spaced clear of the others, or it lands on top of one.

The graph must be ACYCLIC over its \`data\` edges, every edge must name nodes
that exist, and node ids must be unique.
</workflow-editing>`;
}
