import {
  HOST_PLAN_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
} from '../../../agents/chat.types';
import { MAX_CHAT_TEAM_MEMBERS } from '../../../teams/teams.types';
import type { RunTeamForm } from './run-team.schema';

const ANSWER_ARRIVES =
  'The card stands until the user answers. END YOUR TURN right after calling this: the verdict arrives as your next message. A second proposal replaces the card still standing.';

/** What a model reads about `run_team`, for the form its turn is offered. */
export function runTeamInstructions(form: RunTeamForm): string {
  if (form === 'start') {
    return [
      `Run a team of agents from THIS chat, without saving a team first. Use it when the user asks for work to be done by several agents now ("start the architecture work, build a team"). First ask the user what you need to know with an ordinary question. Then call this with a short plan and the agents who should join: each with a name, a public role, its own task, private instructions, and the installed CLI and model you think fit (at most ${MAX_CHAT_TEAM_MEMBERS}; this chat is not listed — it leads them).`,
      'The user sees the plan, this chat as the manager and every agent with its role, task, CLI and model on a card. Start turns this same chat into the team, keeping this conversation, and your next turn opens as its lead; a note the user typed on Start comes with it. Decline leaves the chat as it is.',
      `Start is refused while this chat still has a monitor, a background command or sub-agent, or another card open — the refusal names each, so close them and propose again. Do not use it to save a team for later — use ${HOST_PROPOSE_TEAM_TOOL} for that — nor to lay out a plan of work for yourself alone — use ${HOST_PLAN_TOOL}. ${ANSWER_ARRIVES}`,
    ].join('\n');
  }
  return [
    'Change the team you lead, for this run only: add an agent, remove one, or change an agent\'s role, task, instructions, model or effort. Use it when the user asks for such a change in their own words; never change the team any other way.',
    'The user sees every change on a card — added, leaving and changed agents, with each changed text before and after — and nothing changes until they press Apply. A removed agent finishes its current call, then leaves. A changed agent keeps its memory and works by the new instructions from its next call. An added agent can be called once the change is applied.',
    `The saved team in the library is never changed by this — to change that, use ${HOST_PROPOSE_TEAM_TOOL}. When the user's note on Start asked to add or change one agent, your FIRST call this turn applies that one change at once, with no card; any other change, and every removal, goes on a card. ${ANSWER_ARRIVES}`,
  ].join('\n');
}
