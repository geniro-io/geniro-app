import {
  HOST_PROPOSE_TEAM_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';

const WHAT_IT_ANSWERS =
  "Read the user's geniro team library — the saved teams of agents they run from the Teams " +
  'screen. With no argument it lists every team (slug, name, description, member and stage counts, ' +
  'agents by CLI); with `slug` alone it answers that one team in full as JSON while it fits one answer, ' +
  'else its outline (every member, block and stage, each text replaced by its size); ';

const HOW_TO_READ_PARTS =
  'add `members` or `blocks` (ids) or `stages` to read those parts whole, each text written out between ' +
  'markers naming its path, `search` (words) to find every paragraph that holds one under its path, or ' +
  '`full` for the whole team in pages; a long answer names the `offset` that goes on. ' +
  "An agent's config directory reads as a token, " +
  `"${CONFIG_DIR_TOKEN_PREFIX}…>": `;

/** Who reads the library: an ordinary chat, a team's builder chat, or a project's own chat. */
export type ReadTeamsAudience = 'chat' | 'builder' | 'project';

/**
 * What a model reads about `read_teams` — in an ordinary chat, in the builder
 * chat docked under one team, or in the chat of a project that a team runs.
 */
export function readTeamsInstructions(audience: ReadTeamsAudience): string {
  if (audience === 'project') {
    return (
      "Read the team this project's runs are run by, as the shared team holds it: with no arguments " +
      'it answers the team in full as JSON while it fits one answer, else its outline (every member, ' +
      'block and stage, each text replaced by its size); ' +
      HOW_TO_READ_PARTS +
      `an overlay written with ${HOST_PROPOSE_TEAM_TOOL} keeps it unchanged. Use it when the user asks ` +
      'about the team or what its members do, and before proposing an overlay with ' +
      `${HOST_PROPOSE_TEAM_TOOL}, so a change starts from the team as it stands. It reads only: the team ` +
      'is changed on its own page, never from this chat.'
    );
  }
  if (audience === 'builder') {
    return (
      WHAT_IT_ANSWERS +
      HOW_TO_READ_PARTS +
      `edits to ${HOST_PROPOSE_TEAM_TOOL} or ${HOST_TEAM_CHANGE_TOOL} that write the token back ` +
      'unchanged keep that profile. `overlays` reads every project’s overlay of the team this chat ' +
      'edits, and `projects` every project that runs it by default with its instruction blocks and ' +
      `revision — what a \`project\` change on ${HOST_PROPOSE_TEAM_TOOL} starts from. ` +
      'Use it whenever you read the team this chat edits — before a change: the outline, then ' +
      'the parts the change touches and a search for the words it names, so every place it lives is ' +
      "found — and the user's other teams as examples, by name. It reads only; nothing here changes a team."
    );
  }
  return (
    WHAT_IT_ANSWERS +
    HOW_TO_READ_PARTS +
    'a replacement of that team that keeps the token on an agent of the same CLI keeps that ' +
    'profile, wherever the agent moves; a new team cannot carry one. ' +
    `Use it when the user talks about their teams, and before ${HOST_PROPOSE_TEAM_TOOL}: to ` +
    'see what already exists, to avoid proposing a duplicate, and to start a change from the team ' +
    'as it stands rather than from memory. ' +
    'It reads only; nothing here changes a team.'
  );
}
