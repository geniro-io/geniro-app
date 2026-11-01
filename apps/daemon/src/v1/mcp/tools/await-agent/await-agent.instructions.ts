import {
  CALL_RESULT_ACTIONS,
  CALL_RESULT_PAGES,
} from '../../../teams/utils/callee-text';

/** What a model reads about `await_agent`. */
export function awaitAgentInstructions(): string {
  return (
    'Collect the result envelope of one of YOUR earlier async call_agent calls (or of a sync call that paused on a question). ' +
    'Blocks until that callee finishes or the wait\'s window (timeout_ms) ends — or returns early with a {"status":"question"} envelope when that callee, or ANY other callee of yours, pauses to ask; ' +
    'check the envelope\'s call_id: when it names a different call, "still_running" names the call you were waiting on. ' +
    'Every call stays collectable after you answer via answer_agent. ' +
    'Pass timeout_ms to check in WITHOUT committing to the whole wait: a callee still working answers ' +
    '{"status":"pending"}, which is not a failure — the call is untouched, so go do something else and await it again. ' +
    'A wait (this one, or a sync call_agent) also ends early with {"status":"pending","interrupted":"user_message"} when the user writes to you: ' +
    'answer the user first — the message follows the result — then collect your calls again. ' +
    'OMIT call_id after fanning out several calls: it waits on ALL of them and returns the FIRST thing any produces — a question or a finished result — ' +
    'with its call_id, leaving the rest collectable; call it again to get the next one. Prefer this over waiting on one call while others run. ' +
    `${CALL_RESULT_PAGES} ` +
    `${CALL_RESULT_ACTIONS} ` +
    'Do not sit in await_agent while you have other work to do: an open call notifies you by starting a new turn when it finishes or asks, so it is fine to end your turn and collect then.'
  );
}
