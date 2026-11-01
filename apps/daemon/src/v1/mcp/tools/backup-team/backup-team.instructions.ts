import { HOST_PROPOSE_TEAM_TOOL } from '../../../agents/chat.types';

/** What a model reads about `backup_team`. */
export function backupTeamInstructions(): string {
  return (
    'Copy the team this chat edits, as it stands, to a timed backup the user can restore. ' +
    'Use it whenever the user asks for a backup. ' +
    'The answer names the backup, under the library folder. ' +
    `Do NOT use it before a change you propose with ${HOST_PROPOSE_TEAM_TOOL}: an approved card backs the file up before it saves, and each backup is a full copy of the file that is kept.`
  );
}
