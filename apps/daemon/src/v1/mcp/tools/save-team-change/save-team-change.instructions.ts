import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';

const EDIT_SHAPES =
  'An edit is {find, replace} for text inside a string value (find must occur exactly once in the whole team, or only under its optional `path` — "members/reviewer/instructions" or "members/reviewer" — so a short anchor unique in that field is enough), {path, value} to set a field, or {path, remove: true} to delete one. A path names list elements by id: "members/reviewer/model", "instructionBlocks/-" appends. ';

const SAVE_OUTCOME =
  'Set dryRun to see the diff without saving. On success the old file is backed up first and the answer names the backup. ';

/**
 * What a model reads about `save_team_change` — in an analysis, or in the
 * builder chat docked under one team.
 */
export function saveTeamChangeInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return (
      'Check a change to the team this chat edits WITHOUT saving it: answers where each edit landed (`landed`, one field path per edit, in order) and the diff the edits make to the file as it stands, or which edit would be refused and why. ' +
      `Use it when you want to see where edits would land without changing the team, never as a rehearsal of a card: ${HOST_PROPOSE_TEAM_TOOL} refuses what this refuses without raising one, so to make a change send the edits there straight away. ` +
      `Read the team with ${HOST_READ_TEAMS_TOOL}, then pass only the EDITS — never the whole team. ` +
      EDIT_SHAPES +
      `A configDir token "${CONFIG_DIR_TOKEN_PREFIX}…>" from ${HOST_READ_TEAMS_TOOL} keeps that profile when written back unchanged. ` +
      'It refuses an edit that does not apply, a token that names no profile of this team, an invalid team, and a file something else changed during this turn (read it again and re-apply). ' +
      'A file that cannot be loaded is refused TEAM_UNREADABLE: only then fix what the refusal names in the file with your own file tools. ' +
      'Do NOT use it to make a change — it never saves.'
    );
  }
  return (
    "Save a recommendation the user applied to the analysed thread's team; never write the team file yourself. " +
    `Use it when the user has applied team recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="team", then pass only the EDITS with the \`hash\` you read and the ids of the recommendations they carry out — never the whole team. ` +
    EDIT_SHAPES +
    'It refuses an id the user did not select in the latest Apply, a hash that changed since you read it (read again and re-apply), an edit that does not apply, a deleted team, and an invalid team. ' +
    SAVE_OUTCOME +
    `Do NOT use it for anything the user did not apply — a change they ask for in their own words goes on ${HOST_PROPOSE_TEAM_TOOL} — nor for a project's instructions (${HOST_PROJECT_INSTRUCTIONS_TOOL}); afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
