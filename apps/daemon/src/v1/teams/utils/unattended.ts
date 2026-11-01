import type { Team } from '../teams.types';
import { poolMemberNode, poolSize } from './agent-pool';

/**
 * The agent nodes of a team that can stop and wait for a person to APPROVE
 * something — every agent node whose approval mode is not `auto`.
 *
 * It is the whole question an unattended start has to ask of a team. An
 * approval request never expires and a turn waiting on one is exempt from its
 * silence deadline, so a node that asks, run with nobody watching, parks for
 * good while holding its slot and its worktree (see `AUTOPILOT_APPROVAL`). An
 * agent run is made safe by FORCING `auto`; a team cannot be, because its
 * modes are authored per node and `ask` on one is a deliberate choice. So a
 * team may run unattended exactly when this list is empty, which is what
 * the author already chose for it.
 *
 * `auto` alone, not "anything but ask": `acceptEdits` and `plan` route shell
 * commands (and, for `plan`, everything) to the same approval seam. A node
 * asks when ANY of its pool members does — a call may land on any of them.
 */
export function nodesThatAsk(team: Team): string[] {
  return team.nodes
    .filter(
      (node) =>
        node.kind === 'agent' &&
        Array.from(
          { length: poolSize(node) },
          (_, i) => poolMemberNode(node, i + 1)!.approval,
        ).some((approval) => approval !== 'auto'),
    )
    .map((node) => node.name ?? node.id);
}

/**
 * Every agent of a team that would run tools WITHOUT asking — a node or
 * pool member whose approval mode, its own or inherited, is `auto` — named by
 * the node's unique id (its name beside it when it has one), and a pool member
 * by its number. The inverse reading of {@link nodesThatAsk}, over the same
 * pool helpers, so the two can never disagree about a member.
 *
 * TWIN PARSER: `runsUnasked` in `apps/ui/src/renderer/teams/node-schema.ts`
 * reads the same rule per node for the proposal card.
 */
export function agentsThatRunAuto(team: Team): string[] {
  return team.nodes.flatMap((node) => {
    if (node.kind !== 'agent') {
      return [];
    }
    const label =
      node.name && node.name !== node.id
        ? `${node.name} (${node.id})`
        : node.id;
    return Array.from({ length: poolSize(node) }, (_, i) => i + 1)
      .filter((member) => poolMemberNode(node, member)!.approval === 'auto')
      .map((member) =>
        member === 1 ? label : `${label} — pool member ${member}`,
      );
  });
}
