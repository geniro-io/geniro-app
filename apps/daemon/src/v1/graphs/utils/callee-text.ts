import type { WorkflowAgentNode } from '../graphs.types';
import { poolMemberLabel, poolMembersOf, poolSize } from './agent-pool';

/**
 * How much of a callee's description a caller is shown. Generous on purpose:
 * this is the ONLY thing a caller learns about a callee, so a cap that cuts a
 * two-sentence blurb mid-clause silently deletes routing signal (it used to
 * truncate an arbitrarily long ROLE, where clipping was the point). Still
 * bounded — a runaway field must not swallow the tool description. Both
 * surfaces share the cap, so a node author tunes one length, not two.
 */
export const CALLEE_DESCRIPTION_MAX = 400;

/**
 * Collapse free-form node text to a single line, capped at `max` characters
 * with a trailing ellipsis when longer. Both caller-facing surfaces embed it
 * inline, where a newline or a runaway length would corrupt the surrounding
 * structure (a tool description / a system-prompt block). Empty/absent → ''.
 */
export function flattenText(
  text: string | undefined | null,
  max: number,
): string {
  if (!text) {
    return '';
  }
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The ONE line a caller may be told about one of its callees: how to address
 * it (`call_agent` accepts either the display name or the node id) plus that
 * node's own `description`.
 *
 * A callee's `role` is deliberately NOT included. Role is private
 * instructions — how that agent does its job — and leaking it is what used to
 * force a caller's own role to restate its team's internals. `description` is
 * the public blurb the node author writes FOR its callers, so a caller
 * discovers who it may delegate to, and picks between them, straight from the
 * graph.
 *
 * Both surfaces that describe a callee — the call_agent tool description
 * (McpServerService) and the caller's "May call" awareness block
 * (GraphExecutorService) — go through here, so neither can start leaking role
 * text on its own.
 */
export function calleeSummary(callee: WorkflowAgentNode, max: number): string {
  const name = callee.name ?? callee.id;
  // Spell the id out only when it differs from the name — `Manager (agent id:
  // manager)` is noise in a prompt the model has to read.
  const label = name === callee.id ? name : `${name} (agent id: ${callee.id})`;
  const description = flattenText(callee.description, max);
  const summary = description ? `${label} — ${description}` : label;
  return poolSize(callee) > 1 ? `${summary} ${poolListing(callee)}` : summary;
}

/**
 * A pooled callee's members, numbered as `call_agent`'s `member` takes them —
 * the CLI, model and account of each, so a caller that knows one is spent can
 * name another. Configuration only, never anything from the node's `role`.
 */
function poolListing(callee: WorkflowAgentNode): string {
  const members = poolMembersOf(callee)
    .map((member, index) => `${index + 1}: ${poolMemberLabel(member)}`)
    .join('; ');
  return `[agent pool — ${members}]`;
}
