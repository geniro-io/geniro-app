import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `save_project_instructions`. */
export function saveProjectInstructionsInstructions(
  answersAtOnce: boolean,
): string {
  return (
    "Save a change to the instructions of the project the analysed runs belong to — the ONLY way to change them; it never touches the project's description. " +
    `Use it when the user has applied project-instructions (P-) recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="project", then pass the projectId, every instruction block as it should read with your edits made (keep a block's id to change it, a new id for a new block, leave one out to remove it), the \`instructionsRevision\` you read as baseRevision, and the ids of the P- items the change carries out. ` +
    'Save each project once with every applied item for it. It refuses an id the user did not select in the latest Apply, an item filed about another project, a project no analysed run belongs to, and a revision that changed since you read it (read view="project" again and re-apply). ' +
    (answersAtOnce
      ? 'Call it after every other applied item is done and marked. A change that passes is put on a card showing what changes, and this call returns at once: end your turn, and the user’s Apply or Reject arrives as your next message — mark these items and save the next project only after that answer. '
      : 'Call it after every other applied item is done and marked. A change that passes is put on a card showing what changes, and this call waits until the user presses Apply or Reject; nothing is written without Apply. ') +
    'Every new run in the project receives the saved blocks; threads already running keep what they started with. ' +
    `Do NOT use it for anything the user did not apply, nor for a team's instructions (${HOST_TEAM_CHANGE_TOOL}); afterwards record the outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}

/** What a project's own chat reads about `save_project_instructions`. */
export function projectChatInstructionsInstructions(
  answersAtOnce: boolean,
): string {
  return (
    "Change the instruction blocks of the project this chat belongs to — the ONLY way to change them; it never touches the project's description. " +
    'Use it when the user asks for a change to them: pass every instruction block as it should read with your edits made (keep a block’s id to change it, a new id for a new block, leave one out to remove it) and the instructions revision your brief names as baseRevision. Put everything one request needs in one call. ' +
    'A revision that changed since your brief was written is refused with the blocks as they stand now: make your edits again on those and call it once more. ' +
    (answersAtOnce
      ? 'A change that passes is put on a card showing what changes, and this call returns at once: END YOUR TURN, and the user’s Apply or Reject arrives as your next message. '
      : 'A change that passes is put on a card showing what changes, and this call waits until the user presses Apply or Reject; nothing is written without Apply. ') +
    'Every new run in the project receives the saved blocks; threads already running keep what they started with. ' +
    `Do NOT use it for a change the user did not ask for, nor for what the project's team does in it (${HOST_PROPOSE_TEAM_TOOL}).`
  );
}
