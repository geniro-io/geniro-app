import {
  isLegacyTeamGraph,
  teamFromLegacyDocument,
} from './team-from-workflow';

type Json = Record<string, unknown>;

const LEGACY_DIFF_LISTS: readonly (readonly [string, string])[] = [
  ['addedNodes', 'addedMembers'],
  ['removedNodes', 'removedMembers'],
  ['changedNodes', 'changedMembers'],
];

/** A diff written while teams were node graphs, with its node lists under member names and its edge lists dropped. */
function fromLegacyDiff(diff: Json): Json {
  let current = renamed(diff, 'workflowFields', 'teamFields');
  for (const [from, to] of LEGACY_DIFF_LISTS) {
    current = renamed(current, from, to);
  }
  const { addedEdges: _added, removedEdges: _removed, ...rest } = current;
  void _added;
  void _removed;
  return {
    addedBlocks: [],
    removedBlocks: [],
    changedBlocks: [],
    ...rest,
  };
}

/** A proposed team still written as a node graph, converted; anything else as it is. */
function fromLegacyTeam(team: unknown): unknown {
  if (!isLegacyTeamGraph(team)) {
    return team;
  }
  const converted = teamFromLegacyDocument(team);
  return converted.success ? converted.converted.team : team;
}

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function renamed(value: Json, from: string, to: string): Json {
  if (!(from in value) || to in value) {
    return value;
  }
  const { [from]: moved, ...rest } = value;
  return { ...rest, [to]: moved };
}

/**
 * A `propose_team` card's proposal as today's schema reads it. One raised
 * before the Workflow → Team rename carries its team under `workflow` and its
 * diff's own field list under `workflowFields`; one raised while teams were
 * node graphs proposes a graph, converted here (`teamFromWorkflow`).
 */
export function fromLegacyProposal(proposal: unknown): unknown {
  if (!isObject(proposal)) {
    return proposal;
  }
  const current = renamed(proposal, 'workflow', 'team');
  const team = { ...current, team: fromLegacyTeam(current.team) };
  return isObject(current.diff)
    ? { ...team, diff: fromLegacyDiff(current.diff) }
    : team;
}

/** `Run.pendingTeamProposal` as today's schema reads it — see {@link fromLegacyProposal}. */
export function fromLegacyPendingProposal(pending: unknown): unknown {
  return isObject(pending)
    ? { ...pending, proposal: fromLegacyProposal(pending.proposal) }
    : pending;
}
