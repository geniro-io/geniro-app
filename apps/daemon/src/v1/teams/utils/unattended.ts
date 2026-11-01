import type { Team } from '../teams.types';
import { poolMemberNode, poolSize } from './agent-pool';

/**
 * The members of a team that can stop and wait for a person to APPROVE
 * something — every member whose approval mode is not `auto`.
 *
 * It is the whole question an unattended start has to ask of a team. An
 * approval request never expires and a turn waiting on one is exempt from its
 * silence deadline, so a member that asks, run with nobody watching, parks for
 * good while holding its slot and its worktree (see `AUTOPILOT_APPROVAL`). An
 * agent run is made safe by FORCING `auto`; a team cannot be, because its
 * modes are authored per member and `ask` on one is a deliberate choice. So a
 * team may run unattended exactly when this list is empty, which is what
 * the author already chose for it.
 *
 * `auto` alone, not "anything but ask": `acceptEdits` and `plan` route shell
 * commands (and, for `plan`, everything) to the same approval seam. A member
 * asks when ANY of its pool members does — a call may land on any of them.
 */
export function membersThatAsk(team: Team): string[] {
  return team.members
    .filter((member) =>
      Array.from(
        { length: poolSize(member) },
        (_, i) => poolMemberNode(member, i + 1)!.approval,
      ).some((approval) => approval !== 'auto'),
    )
    .map((member) => member.name);
}

/**
 * Every member of a team that would run tools WITHOUT asking — a member or
 * pool member whose approval mode, its own or inherited, is `auto` — named by
 * the member's unique id (its name beside it when they differ), and a pool
 * member by its number. The inverse reading of {@link membersThatAsk}, over
 * the same pool helpers, so the two can never disagree about a member.
 *
 * TWIN PARSER: `runsUnasked` in `apps/ui/src/renderer/teams/member-schema.ts`
 * reads the same rule per member for the proposal card.
 */
export function agentsThatRunAuto(team: Team): string[] {
  return team.members.flatMap((member) => {
    const label =
      member.name !== member.id ? `${member.name} (${member.id})` : member.id;
    return Array.from({ length: poolSize(member) }, (_, i) => i + 1)
      .filter((index) => poolMemberNode(member, index)!.approval === 'auto')
      .map((index) =>
        index === 1 ? label : `${label} — pool member ${index}`,
      );
  });
}
