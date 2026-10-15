import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `save_workflow_change`. */
export function saveWorkflowChangeInstructions(): string {
  return (
    "Save a change to the analysed thread's workflow — the ONLY way to change it; never write the workflow file yourself. " +
    `Use it when the user has applied workflow recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="workflow", edit its \`workflow\` JSON, and pass the whole edited workflow with the \`hash\` you read and the ids of the recommendations it carries out. ` +
    'It refuses an id the user did not select in the latest Apply, a hash that changed since you read it (read again and re-apply), a deleted workflow, and an invalid graph. ' +
    'Set dryRun to see the diff without saving. On success the old file is backed up first and the answer names the backup. ' +
    `Do NOT use it for anything the user did not apply; afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}
