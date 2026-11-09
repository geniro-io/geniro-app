import { HOST_PROPOSE_TEAM_TOOL } from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';

/** What a model reads about `read_teams`, the same in every chat. */
export function readTeamsInstructions(): string {
  return (
    "Read the user's geniro team library — the saved teams of agents they run from the Teams " +
    'screen. With no argument it lists every team (slug, name, description, member and stage counts, ' +
    'agents by CLI); with `slug` alone it answers that one team in full as JSON while it fits one answer, ' +
    'else its outline (every member, block and stage, each text replaced by its size); ' +
    'add `members` or `blocks` (ids) or `stages` to read those parts whole, each text written out between ' +
    'markers naming its path, `search` (words) to find every paragraph that holds one under its path, or ' +
    '`full` for the whole team in pages; a long answer names the `offset` that goes on. ' +
    "An agent's config directory reads as a token, " +
    `"${CONFIG_DIR_TOKEN_PREFIX}…>": a change that keeps the token on an agent of the same CLI keeps that ` +
    'profile, wherever the agent moves, and so does an overlay that keeps it; a new team cannot carry one. ' +
    "`overlays` with `slug` reads every project's overlay of that team, each under its project's id; " +
    '`projects` with `slug` reads every project that runs it by default with its instruction blocks and ' +
    `revision — what a \`project\` change on ${HOST_PROPOSE_TEAM_TOOL} starts from. ` +
    `Use it when the user talks about their teams, and before ${HOST_PROPOSE_TEAM_TOOL}: to see what ` +
    'already exists, to avoid proposing a duplicate, and to start a change from the team as it stands ' +
    'rather than from memory — the outline, then the parts the change touches and a search for the words ' +
    'it names, so every place it lives is found. It reads only; nothing here changes a team.'
  );
}
