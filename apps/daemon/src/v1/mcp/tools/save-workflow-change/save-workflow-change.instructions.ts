import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `save_workflow_change`. */
export function saveWorkflowChangeInstructions(): string {
  return (
    "Save a change to the analysed thread's workflow — the ONLY way to change it; never write the workflow file yourself. " +
    `Use it when the user has applied workflow recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="workflow", then pass only the EDITS with the \`hash\` you read and the ids of the recommendations they carry out — never the whole workflow. ` +
    'An edit is {find, replace} for text inside a string value (find must occur exactly once in the whole workflow; widen it until it does), {path, value} to set a field, or {path, remove: true} to delete one. A path names list elements by id: "nodes/reviewer/model", "edges/-" appends. ' +
    'It refuses an id the user did not select in the latest Apply, a hash that changed since you read it (read again and re-apply), an edit that does not apply, a deleted workflow, and an invalid graph. ' +
    'Set dryRun to see the diff without saving. On success the old file is backed up first and the answer names the backup. ' +
    `Do NOT use it for anything the user did not apply; afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
