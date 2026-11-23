import {
  HOST_RECORD_OUTCOME_TOOL,
  HOST_TEAM_NOTE_TOOL,
  MILESTONE_TEXT_MAX_CHARS,
} from '../../../agents/chat.types';

/** What a model reads about `milestone`. */
export function milestoneInstructions(): string {
  return (
    "Record one important step of your work as it happens, as one line on the thread's timeline " +
    'and in the transcript, so the user opening the thread later sees at a glance what happened. ' +
    'Use it for the steps a person would want to know about: you started on the cause, you found ' +
    'it, you found a problem (`kind: problem`), a check or verification passed, a piece is done ' +
    '(`kind: done`); `kind` defaults to `progress`. Write it in plain words, at most ' +
    `${MILESTONE_TEXT_MAX_CHARS} characters, one line. Do not use it for routine progress, for every ` +
    `command you run, or to repeat your reply. How the whole thread ended is ${HOST_RECORD_OUTCOME_TOOL}; ` +
    `something another agent of a team should know is ${HOST_TEAM_NOTE_TOOL}. Nothing waits on this ` +
    'call and nobody is woken by it; a step repeating your newest one writes nothing.'
  );
}
