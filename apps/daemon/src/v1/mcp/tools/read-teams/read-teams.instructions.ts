import {
  HOST_PROPOSE_TEAM_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';

const WHAT_IT_ANSWERS =
  "Read the user's geniro team library — the saved teams of agents they run from the Teams " +
  'screen. With no argument it lists every team (slug, name, description, node and edge counts, ' +
  "agents by CLI); with `slug` it answers that one team in full, as JSON — an agent's config " +
  `directory reads as a token, "${CONFIG_DIR_TOKEN_PREFIX}…>": `;

/**
 * What a model reads about `read_teams` — in an ordinary chat, or in the
 * builder chat docked under one team's canvas.
 */
export function readTeamsInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return (
      WHAT_IT_ANSWERS +
      `edits to ${HOST_PROPOSE_TEAM_TOOL} or ${HOST_TEAM_CHANGE_TOOL} that write the token back ` +
      'unchanged keep that profile. ' +
      "Use it when you want the user's other teams as examples, by name; read the team this " +
      `chat edits from its file, which ${HOST_PROPOSE_TEAM_TOOL} changes. ` +
      'It reads only; nothing here changes a team.'
    );
  }
  return (
    WHAT_IT_ANSWERS +
    'a replacement of that team that keeps the token on an agent of the same CLI keeps that ' +
    'profile, wherever the agent moves; a new team cannot carry one. ' +
    `Use it when the user talks about their teams, and before ${HOST_PROPOSE_TEAM_TOOL}: to ` +
    'see what already exists, to avoid proposing a duplicate, and to start a change from the team ' +
    'as it stands rather than from memory. ' +
    'It reads only; nothing here changes a team.'
  );
}
