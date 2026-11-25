import {
  HOST_PLAN_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
} from '../../../agents/chat.types';
import { MAX_CHAT_TEAM_MEMBERS } from '../../../teams/teams.types';

const ANSWER_ARRIVES =
  'The card stands until the user answers. END YOUR TURN right after calling this: the verdict arrives as your next message. A second proposal replaces the card still standing.';

/**
 * What a model reads about `run_team`. ONE text for both forms: a chat that
 * becomes a team keeps the description it loaded as a chat, so a text per
 * form would leave its lead reading the start form's.
 */
export function runTeamInstructions(): string {
  return [
    `Run a team of agents from THIS chat, saved nowhere. In an ordinary chat, START one: use it whenever the user asks for work to be done by several agents now — "build a team", "собери команду", "get agents on this" — even when they do not say how. If the request already says what the job is and who should do it, call this at once; if it is vague ("build a team for payments"), ask one or two short questions first, then call it. Send \`summary\`, \`reason\`, \`plan\` (short steps) and \`team\`: a name and the agents who join, each with a name, a public role, its own task, private instructions, and the installed CLI and model you think fit (at most ${MAX_CHAT_TEAM_MEMBERS}; this chat is not listed — it leads them).`,
    'The user sees the plan, this chat as the manager and every agent on a card. Start turns this same chat into the team, keeping this conversation, and your next turn opens as its lead; Decline leaves the chat as it is. The card changes nothing until Start, so in plan mode call it directly — do not leave plan mode for it; after Start the agents ask before they act. Start is refused while this chat still has a monitor, a background command or sub-agent, or another card open — the refusal names each, so close them and propose again.',
    `As the LEAD of a running team, CHANGE it for this run only: send \`summary\`, \`reason\` and \`edits\` — {op: 'add', member}, {op: 'remove', memberId} or {op: 'update', memberId, …the fields that change} — never \`plan\` or \`team\`, which only start a team. Use it when the user asks for such a change in their own words. The change goes on a card with each changed text before and after, and nothing changes until Apply. A removed agent finishes its current call, then leaves; a changed agent keeps its memory and works by the new instructions from its next call; an added agent can be called once the change is applied.`,
    `When the user's note on Start asked to add or change an agent, your first change this turn that adds or updates one is applied at once, with no card — exactly one; any other change, and every removal, goes on a card.`,
    `Do not use it to save a team for later or to change a saved team in the library — use ${HOST_PROPOSE_TEAM_TOOL} for that, only when the user asks to save one — nor to lay out a plan of work for yourself alone — use ${HOST_PLAN_TOOL}. ${ANSWER_ARRIVES}`,
  ].join('\n');
}
