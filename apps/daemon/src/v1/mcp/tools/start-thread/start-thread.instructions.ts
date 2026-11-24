import { HOST_TELL_THREADS_TOOL } from '../../../agents/chat.types';

/** What the manager reads about `start_thread`. */
export function startThreadInstructions(): string {
  return (
    "Start a new thread for a task. By default it runs in the project's folder like a normal chat and files NO card on the board. Set `card: true` only when the user asked in their own words for a card or task on the board: it then files a backlog card with its own worktree and branch and starts it there. Use it when the user asks for new work, or when work you coordinate needs a thread of its own. " +
    "Give the project (id or exact name), a short title, and a brief — what the thread is to do (with a card, the card's description). `agent` or `team` pick what runs it; the project's default otherwise. " +
    'Outside `auto` the user approves the start with a Start card first (`card_shown`); in `auto` it starts at once (`starting`). Either way you are told when the thread has started and is on your roster, or why it could not start. ' +
    'When the thread finishes, a Done card lands in your chat by itself, with no turn of yours. Set `watch: true` only when the user asks you to watch it or tell them when it finishes — then its reaching done wakes you. ' +
    `Do not use it to message an existing thread — use ${HOST_TELL_THREADS_TOOL}.`
  );
}
