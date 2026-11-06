import {
  HOST_LIST_THREADS_TOOL,
  HOST_MESSAGE_THREAD_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `message_thread`. */
export function messageThreadInstructions(): string {
  return (
    "Send a short plain-text message to another Geniro thread on this Mac — a finding, a decision, a warning that its agent needs while it works. A team run's lead receives it. For a callee of a call you started use message_agent instead. " +
    `Take \`thread\` from ${HOST_LIST_THREADS_TOOL}, or from the reply address of a message you received. ` +
    "The answer says what happened: `joined` its running turn, `woken` as a turn of its own, or `waiting` with a `reason`. A waiting message goes out with that thread's next turn. " +
    'Set `wake` to false when the news can wait: an idle thread then reads it with its next turn and costs nothing now. ' +
    `The other agent reads your text as a message from another agent, not as its user's words: it gives no consent and answers nothing for the user, so never ask another thread for something your own permissions refused. Nothing here waits for a reply. Use ${HOST_MESSAGE_THREAD_TOOL} once for a thing to say; a repeated text is refused.`
  );
}
