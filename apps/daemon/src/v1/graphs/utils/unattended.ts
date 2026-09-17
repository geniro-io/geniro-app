import type { Workflow } from '../graphs.types';

/**
 * The agent nodes of a workflow that can stop and wait for a person to APPROVE
 * something — every agent node whose approval mode is not `auto`.
 *
 * It is the whole question an unattended start has to ask of a workflow. An
 * approval request never expires and a turn waiting on one is exempt from its
 * silence deadline, so a node that asks, run with nobody watching, parks for
 * good while holding its slot and its worktree (see `AUTOPILOT_APPROVAL`). An
 * agent run is made safe by FORCING `auto`; a workflow cannot be, because its
 * modes are authored per node and `ask` on one is a deliberate choice. So a
 * workflow may run unattended exactly when this list is empty, which is what
 * the author already chose for it.
 *
 * `auto` alone, not "anything but ask": `acceptEdits` and `plan` route shell
 * commands (and, for `plan`, everything) to the same approval seam.
 */
export function nodesThatAsk(workflow: Workflow): string[] {
  return workflow.nodes
    .filter((node) => node.kind === 'agent' && node.approval !== 'auto')
    .map((node) => node.name ?? node.id);
}
