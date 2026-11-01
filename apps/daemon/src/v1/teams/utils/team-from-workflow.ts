import {
  INSTRUCTION_BLOCK_EVERYONE,
  type InstructionBlock,
  type LegacyAgentNode,
  type LegacyTeamGraph,
  LegacyTeamGraphSchema,
  type Team,
  type TeamMember,
  type TeamStage,
} from '../teams.types';

export interface ConvertedTeam {
  team: Team;
  /** One line per thing the team shape cannot hold, for a migration log. */
  notes: string[];
  /** The graph it was converted from, as parsed. */
  graph: LegacyTeamGraph;
}

function memberOf(node: LegacyAgentNode): TeamMember {
  const { kind: _kind, description, role, name, ...settings } = node;
  void _kind;
  return {
    ...settings,
    name: name ?? node.id,
    ...(description !== undefined ? { role: description } : {}),
    ...(role !== undefined ? { instructions: role } : {}),
  };
}

function stageOf(
  stage: NonNullable<LegacyTeamGraph['stages']>[number],
): TeamStage {
  return {
    id: stage.id,
    title: stage.title,
    ...(stage.instructions !== undefined
      ? { howToWork: stage.instructions }
      : {}),
    goal: stage.doneWhen,
    ...(stage.ownerHint !== undefined
      ? { responsible: [stage.ownerHint] }
      : {}),
    ...(stage.next !== undefined ? { next: stage.next } : {}),
  };
}

/**
 * A team written as a node graph, as a team of members: agent nodes become
 * members (ids kept, the public `description` their role, the private `role`
 * their instructions), the trigger's data edge names the member that handles
 * the first message, each instruction node becomes a block for the agents its
 * edges reached (all of them: everyone), and a stage's usual owner becomes its
 * one responsible member. Call and data edges and the canvas layout have no
 * counterpart; an agent → agent data edge is named in `notes`.
 */
export function teamFromWorkflow(graph: LegacyTeamGraph): ConvertedTeam {
  const notes: string[] = [];
  const agents = graph.nodes.filter(
    (node): node is LegacyAgentNode => node.kind === 'agent',
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));

  const fed = graph.nodes
    .filter((node) => node.kind === 'trigger')
    .flatMap((trigger) =>
      graph.edges
        .filter(
          (edge) =>
            edge.kind === 'data' &&
            edge.from === trigger.id &&
            agentIds.has(edge.to),
        )
        .map((edge) => edge.to),
    );
  const triggerMember = fed[0] ?? agents[0]?.id;
  if (fed.length === 0 && triggerMember !== undefined) {
    notes.push(
      `no trigger fed an agent; "${triggerMember}" handles the first message`,
    );
  }
  for (const extra of fed.slice(1)) {
    notes.push(
      `the trigger also fed "${extra}"; only "${triggerMember}" handles the first message`,
    );
  }

  const instructionBlocks: InstructionBlock[] = graph.nodes.flatMap((node) => {
    if (node.kind !== 'instruction') {
      return [];
    }
    const reached = new Set(
      graph.edges
        .filter(
          (edge) =>
            edge.kind === 'instruction' &&
            edge.from === node.id &&
            agentIds.has(edge.to),
        )
        .map((edge) => edge.to),
    );
    const everyone =
      agents.length > 0 && agents.every((agent) => reached.has(agent.id));
    return [
      {
        id: node.id,
        title: node.name ?? node.id,
        text: node.instructions,
        audience: everyone
          ? INSTRUCTION_BLOCK_EVERYONE
          : agents.filter((agent) => reached.has(agent.id)).map((a) => a.id),
      },
    ];
  });

  for (const edge of graph.edges) {
    if (
      edge.kind === 'data' &&
      kindOf.get(edge.from) === 'agent' &&
      kindOf.get(edge.to) === 'agent'
    ) {
      notes.push(
        `dropped the data edge "${edge.from}" → "${edge.to}": members hand work on by calling each other`,
      );
    }
  }
  const callEdges = graph.edges
    .filter(
      (edge) =>
        edge.kind === 'call' &&
        kindOf.get(edge.from) === 'agent' &&
        kindOf.get(edge.to) === 'agent',
    )
    .map((edge) => `"${edge.from}" → "${edge.to}"`);
  if (callEdges.length > 0) {
    notes.push(
      `every member may now call every other; the graph allowed only ${callEdges.join(', ')}`,
    );
  }

  const team: Team = {
    name: graph.name,
    ...(graph.description !== undefined
      ? { description: graph.description }
      : {}),
    ...(graph.maxActiveTurns !== undefined
      ? { maxActiveTurns: graph.maxActiveTurns }
      : {}),
    mode: 'lead',
    members: agents.map(memberOf),
    triggers:
      triggerMember === undefined
        ? []
        : [{ kind: 'first-message', member: triggerMember }],
    instructionBlocks,
    ...(graph.stages !== undefined
      ? { stages: graph.stages.map(stageOf) }
      : {}),
  };
  return { team, notes, graph };
}

/** Whether a parsed document is written in the node-graph shape. */
export function isLegacyTeamGraph(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('members' in value) &&
    ('nodes' in value || 'edges' in value)
  );
}

/** A node-graph document read and converted, or the parse failure. */
export function teamFromLegacyDocument(
  value: unknown,
):
  | { success: true; converted: ConvertedTeam }
  | { success: false; error: string } {
  const parsed = LegacyTeamGraphSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { success: true, converted: teamFromWorkflow(parsed.data) };
}
