import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_BACKUP_WORKFLOW_TOOL,
  HOST_READ_WORKFLOWS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../graphs/utils/config-dir-redaction';

const EDIT_SHAPES =
  'An edit is {find, replace} for text inside a string value (find must occur exactly once in the whole workflow; widen it until it does), {path, value} to set a field, or {path, remove: true} to delete one. A path names list elements by id: "nodes/reviewer/model", "edges/-" appends. ';

const SAVE_OUTCOME =
  'Set dryRun to see the diff without saving. On success the old file is backed up first and the answer names the backup. ';

/**
 * What a model reads about `save_workflow_change` — in an analysis, or in the
 * builder chat docked under one workflow's canvas.
 */
export function saveWorkflowChangeInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return (
      'Save a change to the workflow this chat edits — the ONLY way to change it; never write the workflow file yourself. ' +
      'Use it when the user asks you to change this workflow: read the file with your own tools, then pass only the EDITS, applied to the file as it stands — never the whole workflow. ' +
      EDIT_SHAPES +
      `A configDir token "${CONFIG_DIR_TOKEN_PREFIX}…>" from ${HOST_READ_WORKFLOWS_TOOL} keeps that profile when written back unchanged. ` +
      'It refuses an edit that does not apply, a token that names no profile of this workflow, an invalid graph, and a file something else changed during this turn (read it again and re-apply). ' +
      'A file that cannot be loaded is refused WORKFLOW_UNREADABLE: only then fix what the refusal names in the file with your own file tools, and save again. ' +
      `Set dryRun to see the diff without saving. It takes no backup: call ${HOST_BACKUP_WORKFLOW_TOOL} first when the change is one the user may want undone. ` +
      'Do NOT use it for a change the user did not ask for.'
    );
  }
  return (
    "Save a change to the analysed thread's workflow — the ONLY way to change it; never write the workflow file yourself. " +
    `Use it when the user has applied workflow recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="workflow", then pass only the EDITS with the \`hash\` you read and the ids of the recommendations they carry out — never the whole workflow. ` +
    EDIT_SHAPES +
    'It refuses an id the user did not select in the latest Apply, a hash that changed since you read it (read again and re-apply), an edit that does not apply, a deleted workflow, and an invalid graph. ' +
    SAVE_OUTCOME +
    `Do NOT use it for anything the user did not apply; afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
