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

/** What a call naming no target means in the chat listing the tool, and what only that chat holds. */
const IN_THIS_CHAT: Record<ProposeTeamAudience, string | null> = {
  chat: null,
  builder: `In this chat \`edits\` without \`replaces\` change the team this chat edits, applied to the file as it stands, and it need not be able to run yet: a team is built up over several changes. A refusal raises no card, so propose straight away rather than trying edits out first. A file that cannot be loaded is refused TEAM_UNREADABLE: only then fix what the refusal names in the file with your own file tools, and propose again. After an Apply, one card carries every selected W- and O- item and the P- items of a project that runs this team, with \`recommendation_ids\` naming them.`,
  project:
    "In this chat an `overlay` without `overlayProjectId` is this project's own, the one your brief shows.",
  analysis: `What the user applied from your recommendations card keeps its own tools (${HOST_TEAM_CHANGE_TOOL}, ${HOST_PROJECT_INSTRUCTIONS_TOOL}); this one is for a change they ask for in their own words.`,
};

/** What a model reads about `propose_team`, the same in every chat but for what naming no target means there. */
export function proposeTeamInstructions(audience: ProposeTeamAudience): string {
  const inThisChat = IN_THIS_CHAT[audience];
  return [
    "Propose a geniro team — CLI agents as members who may call each other — or a change to one in the library, on a card the user approves. The daemon checks it and, only on the user's Approve, writes it to their team library (backing up a file it replaces). You never write the file yourself.",
    `Use it when the user asks you to build, set up or change a team of agents, whichever team it is and whichever chat you are in. Read the library first with ${HOST_READ_TEAMS_TOOL}. A new team goes whole in \`team\`. To change a team the library holds, send only the EDITS with \`replaces\` set to its slug and a one-line \`summary\` and \`reason\` — never the whole team, which runs to hundreds of kilobytes: read the parts you change with ${HOST_READ_TEAMS_TOOL} (\`members\`, \`blocks\`, \`search\`) and copy each \`find\` from the text between a field's \`===\` markers. The card shows the exact difference. Put everything one request needs on one card.`,
    ...(inThisChat === null ? [] : [inThisChat]),
    `To change how a project's default team works in that one project — its overlay — find the project and its team with list_projects, read the overlay with ${HOST_READ_TEAMS_TOOL} (\`slug\` and \`overlays\`; a project it does not name has none yet), then send the WHOLE overlay as it should stand in \`overlay\`, the project's id in \`overlayProjectId\`, and a one-line \`summary\` and \`reason\`: alone, the team itself stays as it is. Leave a Model setting unset unless the user names a value: a value the CLI does not know fails the member at run time.\n${OVERLAY_FORMAT}`,
    `To move text between a team and a project that runs it by default — rules that belong to that project, not to every project — send the team's edits beside \`overlay\` and \`overlayProjectId\`, or beside \`project\` (its id, every block as it should read with a kept one as its id alone, and the revision ${HOST_READ_TEAMS_TOOL} named with \`projects\`), on the SAME card: one approval writes both, and a failed team write puts the other back. Never move text in two cards, or through ${HOST_PROJECT_INSTRUCTIONS_TOOL}.`,
    `Do not use it for a change the user did not ask for, to lay out a plan of work for this chat — use ${HOST_PLAN_TOOL} instead — or for a project's own instruction blocks alone, which reach every member — use ${HOST_PROJECT_INSTRUCTIONS_TOOL}. It never runs a team.`,
    "Every member must state `approval`: 'auto' lets that member run tools without asking — choose it only where the user wants that; the card lists every such member for the user. Give each member a `name`, a public `role` (what it does — the others read it to decide whom to call) and private `instructions`. A team has `mode: lead` and exactly one trigger, `{kind: first-message, member}`, naming the member that coordinates; `instructionBlocks` reach their `audience` (`everyone` or member ids).",
    `A proposal that could not run, edits that do not apply, break the schema or the team rules, or change nothing, and an overlay the team cannot take or that changes nothing, are refused with the reason, and no card is shown. ${ANSWER_ARRIVES}`,
  ].join('\n');
}
