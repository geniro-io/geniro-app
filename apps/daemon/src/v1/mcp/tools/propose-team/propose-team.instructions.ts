import {
  HOST_PLAN_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../../agents/chat.types';

const ANSWER_ARRIVES =
  'Otherwise the card stands until the user answers, with no time limit: END YOUR TURN after calling this. The verdict — approved and saved, declined with their note, or not saved and why — arrives as your next message. A second proposal replaces the card still standing.';

/**
 * What a model reads about `propose_team` — in an ordinary chat, or in the
 * builder chat docked under one team.
 */
export function proposeTeamInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return [
      "Propose a change to the team this chat edits, on a card the user approves — the ONLY way to change it; never write the team file yourself. The card shows your summary of what changes, your reason why, and the exact difference to the file; the daemon saves it only on the user's Approve, backing the file up first.",
      'Use it whenever the user asks for a change to this team, a whole new team built in it included: read the file with your own tools, then pass only the EDITS, applied to the file as it stands — never the whole team. Put everything one request needs on one card.',
      `Do not use it for a change the user did not ask for. To try edits out first, ${HOST_TEAM_CHANGE_TOOL} answers the same diff without a card.`,
      'Edits that do not apply, break the schema or the team rules, or change nothing are refused with the reason, and no card is shown. A file that cannot be loaded is refused TEAM_UNREADABLE: only then fix what the refusal names in the file with your own file tools, and propose again.',
      ANSWER_ARRIVES,
    ].join('\n');
  }
  return [
    "Propose a whole geniro team — CLI agents as members who may call each other — on a card the user approves. The daemon checks it the way a run start would and, only on the user's Approve, writes it to their team library (backing up a file it replaces). You never write the file yourself.",
    `Use it when the user asks you to build, set up or change a team of agents. Read the library first with ${HOST_READ_TEAMS_TOOL}; to change an existing team, send it whole with \`replaces\` set to its slug.`,
    `Do not use it to lay out a plan of work for this chat — use ${HOST_PLAN_TOOL} instead. It never runs a team.`,
    "Every member must state `approval`: 'auto' lets that member run tools without asking — choose it only where the user wants that; the card lists every such member for the user. Give each member a `name`, a public `role` (what it does — the others read it to decide whom to call) and private `instructions`. A team has `mode: lead` and exactly one trigger, `{kind: first-message, member}`, naming the member that coordinates; `instructionBlocks` reach their `audience` (`everyone` or member ids).",
    `A proposal that could not run is refused with the reason, and no card is shown. ${ANSWER_ARRIVES}`,
  ].join('\n');
}
