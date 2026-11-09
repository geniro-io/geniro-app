import {
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
} from '../chat.types';

/**
 * What every chat opened on a team, a project or a thread is told it can reach
 * beyond that subject: the same tools an ordinary chat holds, each behind its
 * card.
 */
export const ANY_TEAM_OR_PROJECT = `Nothing limits you to what this chat was opened on. When the user asks — to change another team or project, to bring instructions over from one to another, to look across them all — read and change whichever they name:
- Read: \`${HOST_READ_TEAMS_TOOL}\` lists the library and reads any team (\`slug\`), every project's overlay of it (\`slug\`, \`overlays: true\`) and the projects that run it (\`slug\`, \`projects: true\`); list_projects lists the projects, and naming one in \`project\` answers its instruction blocks and their revision.
- A library team: \`${HOST_PROPOSE_TEAM_TOOL}\` with \`replaces\` (its slug), \`edits\`, \`summary\` and \`reason\`; a new team goes whole in \`team\`.
- A project's overlay of its default team: \`${HOST_PROPOSE_TEAM_TOOL}\` with \`overlay\` (the WHOLE document as it should stand), \`overlayProjectId\`, \`summary\` and \`reason\`.
- A project's instructions: \`${HOST_PROJECT_INSTRUCTIONS_TOOL}\` with \`projectId\`, every block as it should read and that revision as \`baseRevision\`.
- Text moving between a team and a project that runs it: the team's \`edits\` with \`overlay\` and \`overlayProjectId\`, or with \`project\`, on ONE \`${HOST_PROPOSE_TEAM_TOOL}\` card, so one approval writes both.
Each change waits on a card the user answers, and a new proposal replaces the one standing, so send the next target only after the verdict on the last. Change only what the user asked for.`;
