import type { Team, TeamMember } from '../teams.types';

/** One member with the fields a team requires, `name` its id unless given. */
export function member(
  id: string,
  overrides: Partial<TeamMember> = {},
): TeamMember {
  return { id, name: id, agent: 'claude', approval: 'auto', ...overrides };
}

/** A lead-mode team of `members`, the first handling the first message unless `overrides` say otherwise. */
export function teamOf(
  members: TeamMember[],
  overrides: Partial<Team> = {},
): Team {
  return {
    name: 'team',
    mode: 'lead',
    members,
    triggers:
      members[0] === undefined
        ? []
        : [{ kind: 'first-message', member: members[0].id }],
    instructionBlocks: [],
    ...overrides,
  };
}
