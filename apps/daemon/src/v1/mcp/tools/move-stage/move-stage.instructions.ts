export function moveStageInstructions(): string {
  return (
    "Move this workflow run's stages — the steps every run of the workflow walks, listed in your " +
    'instructions. Use action "complete" when the current stage\'s "done when" holds, with a one-line ' +
    'summary of what was done; "skip" when the current stage does not apply to this run, with the ' +
    'reason; "reopen" when a finished or skipped stage turns out unfinished, with the reason (every ' +
    'stage after it reopens too). Name the stage by its id. At a stage followed by ONE of several ' +
    'stages, pass the one the run takes as "next". Any agent of the run may move a stage; "usually ' +
    'done by" is a hint. The reply says what moved and gives the stage to work on next. The stages ' +
    "are the run's shared progress, not your own checklist — keep your own steps in your task list " +
    '(TodoWrite / TaskCreate); tell other agents a finding with a team note (team_note); record a ' +
    "pull request's outcome with record_outcome."
  );
}
