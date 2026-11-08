import {
  HOST_PLAN_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../../agents/chat.types';
import { OVERLAY_FORMAT } from '../../../teams/utils/team-chat-instructions';
import type { ProposeTeamAudience } from './propose-team.schema';

const ANSWER_ARRIVES =
  'Otherwise the card stands until the user answers, with no time limit: END YOUR TURN after calling this. The verdict — approved and saved, declined with their note, or not saved and why — arrives as your next message. A second proposal replaces the card still standing.';

/**
 * What a model reads about `propose_team` — in an ordinary chat, in the
 * builder chat docked under one team, or in a project's own chat.
 */
export function proposeTeamInstructions(audience: ProposeTeamAudience): string {
  if (audience === 'project') {
    return [
      "Propose a change to how this project's default team works in it — its overlay: a member's model, effort, profile or approval, its fallback pool, its extra instructions, or instruction blocks only this project's runs carry — on a card the user approves. The ONLY way to change the overlay; never write its file yourself. The daemon saves it only on the user's Approve, backing the file up first.",
      'Use it whenever the user asks for such a change: pass the WHOLE overlay as it should stand — the one your brief shows, with your change made — plus a one-line summary and the reason. Put everything one request needs on one card.',
      `Do not use it for a change the user did not ask for, for the project's own instruction blocks (${HOST_PROJECT_INSTRUCTIONS_TOOL}), or for the shared team itself, which is changed on its own page.`,
      'An overlay that breaks the schema, that the team cannot take, or that changes nothing is refused with the reason, and no card is shown.',
      ANSWER_ARRIVES,
    ].join('\n');
  }
  if (audience === 'builder') {
    return [
      "Propose a change to the team this chat edits, on a card the user approves — the ONLY way to change it; never write the team file yourself. The card shows your summary of what changes, your reason why, and the exact difference to the file; the daemon saves it only on the user's Approve, backing the file up first.",
      `Use it whenever the user asks for a change to this team, a whole new team built in it included: read the team with ${HOST_READ_TEAMS_TOOL}, then pass only the EDITS, applied to the file as it stands — never the whole team. Put everything one request needs on one card.`,
      `To move text between this team and a project that runs it by default — rules that belong to that project, not to every project — send the team edits and \`project\` (its id, every block as it should read with a kept one as its id alone, and the revision ${HOST_READ_TEAMS_TOOL} named with \`projects\`) on the SAME card: one approval writes both, the project first, and a failed team write puts the project back. Never move text in two cards, or through ${HOST_PROJECT_INSTRUCTIONS_TOOL}.`,
      `Do not use it for a change the user did not ask for. To try edits out first, ${HOST_TEAM_CHANGE_TOOL} answers the same diff without a card.`,
      'Edits that do not apply, break the schema or the team rules, or change nothing are refused with the reason, and no card is shown. A file that cannot be loaded is refused TEAM_UNREADABLE: only then fix what the refusal names in the file with your own file tools, and propose again.',
      ANSWER_ARRIVES,
    ].join('\n');
  }
  return [
    "Propose a geniro team — CLI agents as members who may call each other — or a change to one in the library, on a card the user approves. The daemon checks it the way a run start would and, only on the user's Approve, writes it to their team library (backing up a file it replaces). You never write the file yourself.",
    `Use it when the user asks you to build, set up or change a team of agents. Read the library first with ${HOST_READ_TEAMS_TOOL}. A new team goes whole in \`team\`. To change a team the library holds, send only the EDITS with \`replaces\` set to its slug and a one-line \`summary\` and \`reason\` — never the whole team, which runs to hundreds of kilobytes: read the parts you change with ${HOST_READ_TEAMS_TOOL} (\`members\`, \`blocks\`, \`search\`) and copy each \`find\` from the text between a field's \`===\` markers. The card shows the exact difference. Put everything one request needs on one card.`,
    `To change how a project's default team works in that one project — its overlay — find the project and its team with list_projects, read the overlay with ${HOST_READ_TEAMS_TOOL} (\`slug\` and \`overlays\`; a project it does not name has none yet), then send the WHOLE overlay as it should stand in \`overlay\`, the project's id in \`overlayProjectId\`, and a one-line \`summary\` and \`reason\`, on a card of its own: the team itself stays as it is. Leave a Model setting unset unless the user names a value: a value the CLI does not know fails the member at run time.\n${OVERLAY_FORMAT}`,
    `Do not use it to lay out a plan of work for this chat — use ${HOST_PLAN_TOOL} instead, or for a project's own instruction blocks, which reach every member — use ${HOST_PROJECT_INSTRUCTIONS_TOOL}. It never runs a team.`,
    "Every member must state `approval`: 'auto' lets that member run tools without asking — choose it only where the user wants that; the card lists every such member for the user. Give each member a `name`, a public `role` (what it does — the others read it to decide whom to call) and private `instructions`. A team has `mode: lead` and exactly one trigger, `{kind: first-message, member}`, naming the member that coordinates; `instructionBlocks` reach their `audience` (`everyone` or member ids).",
    `A proposal that could not run, edits that do not apply, break the schema or the team rules, or change nothing, and an overlay the team cannot take or that changes nothing, are refused with the reason, and no card is shown. ${ANSWER_ARRIVES}`,
  ].join('\n');
}
