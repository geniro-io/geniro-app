type Json = Record<string, unknown>;

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
 * before the rename carries its team under `workflow` and its diff's own
 * field list under `workflowFields`.
 */
export function fromLegacyProposal(proposal: unknown): unknown {
  if (!isObject(proposal)) {
    return proposal;
  }
  const current = renamed(proposal, 'workflow', 'team');
  return isObject(current.diff)
    ? {
        ...current,
        diff: renamed(current.diff, 'workflowFields', 'teamFields'),
      }
    : current;
}

/** `Run.pendingTeamProposal` as today's schema reads it — see {@link fromLegacyProposal}. */
export function fromLegacyPendingProposal(pending: unknown): unknown {
  return isObject(pending)
    ? { ...pending, proposal: fromLegacyProposal(pending.proposal) }
    : pending;
}
