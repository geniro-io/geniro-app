import { HOST_WORKFLOW_CHANGE_TOOL } from '../../../agents/chat.types';

/** What a model reads about `backup_workflow`. */
export function backupWorkflowInstructions(): string {
  return (
    'Copy the workflow this chat edits, as it stands, to a timed backup the user can restore — ' +
    `${HOST_WORKFLOW_CHANGE_TOOL} does not back it up. ` +
    'Use it when a change you are about to save is one the user may want undone: a rework of ' +
    'several agents or of the wiring, a removal, or whenever the user asks for a backup. ' +
    'The answer names the backup, under the library folder. ' +
    'Do NOT use it before every small edit: each backup is a full copy of the file and is kept.'
  );
}
