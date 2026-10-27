import { HOST_PROPOSE_WORKFLOW_TOOL } from '../../../agents/chat.types';

/** What a model reads about `backup_workflow`. */
export function backupWorkflowInstructions(): string {
  return (
    'Copy the workflow this chat edits, as it stands, to a timed backup the user can restore. ' +
    'Use it whenever the user asks for a backup. ' +
    'The answer names the backup, under the library folder. ' +
    `Do NOT use it before a change you propose with ${HOST_PROPOSE_WORKFLOW_TOOL}: an approved card backs the file up before it saves, and each backup is a full copy of the file that is kept.`
  );
}
