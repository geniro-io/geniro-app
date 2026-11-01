import type { Team, TeamMember } from '../teams.types';

/** The member that handles the first message, or null for a team without a usable trigger. */
export function triggerMemberId(
  team: Pick<Team, 'members' | 'triggers'>,
): string | null {
  const id = team.triggers[0]?.member;
  return id !== undefined && team.members.some((member) => member.id === id)
    ? id
    : null;
}

export function triggerMemberOf(
  team: Pick<Team, 'members' | 'triggers'>,
): TeamMember | null {
  const id = triggerMemberId(team);
  return team.members.find((member) => member.id === id) ?? null;
}

/**
 * The members that run only when called. In `lead` mode that is every member
 * but the one that handles the first message.
 */
export function onDemandMemberIds(
  team: Pick<Team, 'members' | 'triggers'>,
): Set<string> {
  const lead = triggerMemberId(team);
  return new Set(
    team.members.map((member) => member.id).filter((id) => id !== lead),
  );
}

/**
 * Every member a member may call: all the others. A team of one has nobody
 * to call, so it maps no caller and runs no call runtime.
 */
export function calleesOf(
  members: readonly TeamMember[],
): Map<string, readonly TeamMember[]> {
  return members.length < 2
    ? new Map()
    : new Map(
        members.map((member) => [
          member.id,
          members.filter((other) => other.id !== member.id),
        ]),
      );
}
