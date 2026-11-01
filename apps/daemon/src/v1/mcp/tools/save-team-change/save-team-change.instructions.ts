import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';

const EDIT_SHAPES =
  'An edit is {find, replace} for text inside a string value (find must occur exactly once in the whole team; widen it until it does), {path, value} to set a field, or {path, remove: true} to delete one. A path names list elements by id: "members/reviewer/model", "instructionBlocks/-" appends. ';

const SAVE_OUTCOME =
  'Set dryRun to see the diff without saving. On success the old file is backed up first and the answer names the backup. ';

/**
 * What a model reads about `save_team_change` — in an analysis, or in the
 * builder chat docked under one team.
 */
export function saveTeamChangeInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return (
      'Check a change to the team this chat edits WITHOUT saving it: answers the diff the edits make to the file as it stands, or why they would be refused. ' +
      `Use it when you want to try out a set of edits before you put them on a card; to make the change, send the same edits to ${HOST_PROPOSE_TEAM_TOOL}, which shows the user what changes and why and saves it on their Approve. ` +
      'Read the file with your own tools, then pass only the EDITS — never the whole team. ' +
      EDIT_SHAPES +
      `A configDir token "${CONFIG_DIR_TOKEN_PREFIX}…>" from ${HOST_READ_TEAMS_TOOL} keeps that profile when written back unchanged. ` +
      'It refuses an edit that does not apply, a token that names no profile of this team, an invalid team, and a file something else changed during this turn (read it again and re-apply). ' +
      'A file that cannot be loaded is refused TEAM_UNREADABLE: only then fix what the refusal names in the file with your own file tools. ' +
      'Do NOT use it to make a change — it never saves.'
    );
  }
  return (
    "Save a change to the analysed thread's team — the ONLY way to change it; never write the team file yourself. " +
    `Use it when the user has applied team recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="team", then pass only the EDITS with the \`hash\` you read and the ids of the recommendations they carry out — never the whole team. ` +
    EDIT_SHAPES +
    'It refuses an id the user did not select in the latest Apply, a hash that changed since you read it (read again and re-apply), an edit that does not apply, a deleted team, and an invalid team. ' +
    SAVE_OUTCOME +
    `Do NOT use it for anything the user did not apply; afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
