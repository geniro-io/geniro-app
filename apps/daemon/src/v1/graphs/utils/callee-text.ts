import { maskedCommand } from '../../agents/utils/command-text';
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
 * What EVERY callee is told about where its answer goes, whether or not it may
 * call anyone itself — its own instruction part (`answeringACallPrompt`), and
 * the lead of `call_agent`'s description for a callee that can call. CLI-
 * neutral: whether a turn is held for background sub-agents is the adapter's
 * note to make (`AdapterConfig.backgroundWork`).
 */
export const ANSWERING_A_CALL =
  'You are answering a call from another agent. Your answer to it is the reply you end your final turn in this call with — put your full answer there, never only a note that the work is under way.';

/**
 * What a callee that can itself call is told about ending its turn — said in
 * the "May call" block AND in `call_agent`'s description, which must agree,
 * each time after {@link ANSWERING_A_CALL}. Without it the "end your turn"
 * steering every caller gets reads, to a callee, as permission to hand back
 * "I've delegated it" as its whole answer.
 */
export const ANSWERING_WITH_CALLS_OUT =
  'Ending your turn while async or sync calls you made are still running does NOT hand back your result: that call stays open, you are started again inside it when they finish or ask, and the reply you end THAT turn with is your result — so put your full answer in the turn that has nothing left running. Fire-and-forget calls are not waited for.';

/**
 * What a caller is told about the pages its callees publish — said in both
 * `call_agent`'s and `await_agent`'s descriptions, since either returns the
 * finished envelope. The broker's `withPublished` is what keeps it true.
 */
export const CALL_RESULT_PAGES =
  'A finished call\'s envelope — its result, or the envelope itself when the call failed — lists under "artifacts" every page the callee — or an agent it called — published with show_artifact during the call, by artifact_id, title and version. Those pages are already in the user\'s chat: point the user at them by title, and never publish them again or restate their content.';

/** The same promise, as the `note` of an envelope that carries `artifacts`. */
export const PUBLISHED_PAGES_NOTE =
  'The pages in "artifacts" are already in the user\'s chat — they were shown there as they were published. ' +
  'Point the user at a page by its title instead of publishing it again or restating what it shows.';

/**
 * What a caller is told about the buttons its callees publish — said beside
 * {@link CALL_RESULT_PAGES}, and kept true by the broker's `withPublished`.
 */
export const CALL_RESULT_ACTIONS =
  'It also lists under "actions" every button the callee — or an agent it called — published with publish_action during the call and has not removed, by action_id, label and kind. Those buttons were put in the user\'s chat for the user to press (the user may have pressed or dismissed one since); a press of a message button is delivered to the agent the user\'s messages go to, naming who published it. Mention one by its label when the user needs it; never publish it again.';

/** The same promise, as the `note` of an envelope that carries `actions`. */
export const PUBLISHED_ACTIONS_NOTE =
  'The buttons in "actions" were put in the user\'s chat for the user to press, and may have been pressed or dismissed since. ' +
  'Mention one by its label when the user needs it instead of publishing it again.';

/**
 * How much of each command a call left running its caller is shown — enough
 * to recognise `pnpm dev:web` behind its `cd` prefix, short enough that a
 * fan-out of servers cannot swamp the result text it sits beside.
 */
export const LEFT_RUNNING_COMMAND_MAX = 160;

/**
 * A command a callee left running, as its caller is shown it — on one line,
 * capped and masked ({@link maskedCommand}). The words go to the CALLER's
 * provider, which need not be the callee's.
 */
export function quotedCommand(command: string): string {
  return flattenText(maskedCommand(command), LEFT_RUNNING_COMMAND_MAX);
}

/**
 * Collapse free-form node text to a single line, capped at `max` characters
 * with a trailing ellipsis when longer. Every caller-facing surface embeds it
 * inline, where a newline or a runaway length would corrupt the surrounding
 * structure (a tool description, a system-prompt block, a call result's
 * note). Empty/absent → ''.
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
