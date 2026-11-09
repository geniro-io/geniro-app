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
    `Use it when the user has applied project-instructions (P-) recommendations: read ${HOST_ANALYZED_THREAD_TOOL} view="project", then pass the projectId, every instruction block as it should read with your edits made (a block you keep unchanged as its id alone, a changed one with its id, title and text, a new one with a new id; leave one out to remove it), the \`instructionsRevision\` you read as baseRevision, and the ids of the P- items the change carries out. ` +
    'Save each project once with every applied item for it. It refuses an id the user did not select in the latest Apply, an item filed about another project, a project no analysed run belongs to, a revision that changed since you read it (read view="project" again and re-apply), and blocks whose texts together run past the `instructionsMaxChars` view="project" names — before any card, with the figures. ' +
    (answersAtOnce
      ? 'Call it after every other applied item is done and marked. A change that passes is put on a card showing what changes, and this call returns at once: end your turn, and the user’s Apply or Reject arrives as your next message — mark these items and save the next project only after that answer. '
      : 'Call it after every other applied item is done and marked. A change that passes is put on a card showing what changes, and this call waits until the user presses Apply or Reject; nothing is written without Apply. ') +
    'Every new run in the project receives the saved blocks; threads already running keep what they started with. ' +
    `When the user asks in their own words for a change to any project's instructions, read the project with list_projects naming it in \`project\` and pass its id, the blocks and that \`instructionsRevision\` with no ids; those checks and the marks then do not apply. ` +
    `Do NOT use it for anything the user neither applied nor asked for, nor for a team's instructions (${HOST_TEAM_CHANGE_TOOL}); afterwards record an applied item's outcome with ${HOST_RECOMMENDATION_MARKS_TOOL}.`
  );
}

/** What a project's own chat reads about `save_project_instructions`. */
export function projectChatInstructionsInstructions(
  answersAtOnce: boolean,
): string {
  return (
    "Change the instruction blocks of the project this chat belongs to, or of any other — the ONLY way to change them; it never touches a project's description. " +
    'Use it when the user asks for a change to them: pass every instruction block as it should read with your edits made (a block you keep unchanged as its id alone, a changed one with its id, title and text, a new one with a new id; leave one out to remove it) and the instructions revision your brief names as baseRevision. For another project, read it first with list_projects naming it in `project` and pass its `id` as projectId and its `instructionsRevision` as baseRevision. Blocks whose texts together run past the limit are refused before any card, with the figures. Put everything one request needs in one call. ' +
    'A revision that changed since you read it is refused with the blocks as they stand now: make your edits again on those and call it once more. ' +
    (answersAtOnce
      ? 'A change that passes is put on a card showing what changes, and this call returns at once: END YOUR TURN, and the user’s Apply or Reject arrives as your next message. '
      : 'A change that passes is put on a card showing what changes, and this call waits until the user presses Apply or Reject; nothing is written without Apply. ') +
    'Every new run in the project receives the saved blocks; threads already running keep what they started with. ' +
    `Do NOT use it for a change the user did not ask for, nor for what a team does in a project (${HOST_PROPOSE_TEAM_TOOL}).`
  );
}

export function ordinaryChatInstructionsInstructions(
  answersAtOnce: boolean,
): string {
  return (
    "Change the instruction blocks of a project — what every new run in it receives — the ONLY way to change them; it never touches the project's description. " +
    "Use it when the user asks for a change to a project's instructions: read the project first with list_projects naming it in `project` (its `id`, its `instructionBlocks`, their `instructionsRevision` and the size limit), then pass the projectId, every instruction block as it should read with your edits made (a block you keep unchanged as its id alone, a changed one with its id, title and text, a new one with a new id; leave one out to remove it) and that `instructionsRevision` as baseRevision. Put everything one request needs in one call. Blocks whose texts together run past the limit are refused before any card, with the figures. " +
    'A revision that changed since you read it is refused with the blocks as they stand now: make your edits again on those and call it once more. ' +
    (answersAtOnce
      ? 'A change that passes is put on a card showing what changes, and this call returns at once: END YOUR TURN, and the user’s Apply or Reject arrives as your next message. '
      : 'A change that passes is put on a card showing what changes, and this call waits until the user presses Apply or Reject; nothing is written without Apply. ') +
    'Threads already running keep what they started with. ' +
    `Do NOT use it for a change the user did not ask for, nor for how a team works (${HOST_PROPOSE_TEAM_TOOL}).`
  );
}
