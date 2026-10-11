import { MAX_ANSWER_LENGTH } from '../../../agents/chat.types';
import { MAX_HOST_QUESTION_TITLE_LENGTH } from '../../../agents/utils/host-question';

/**
 * The card's optional heading, read and bounded here with the rest of the
 * call's arguments so the endpoint never passes one through raw. Blank reads
 * as absent, on the chart's and the gallery's rule.
 */
export function readHostQuestionTitle(
  args: Record<string, unknown>,
): string | null {
  if (typeof args.title !== 'string') {
    return null;
  }
  const trimmed = args.title.trim();
  return trimmed.length === 0
    ? null
    : trimmed.slice(0, MAX_HOST_QUESTION_TITLE_LENGTH);
}

/**
 * The tool result text for one outcome.
 *
 * Every arm SAYS which it is, because the three are decisions the agent has to
 * act on differently and an answer-shaped string for all of them would have a
 * refusal read as an answer. The answer is bounded on the way out for the
 * reason it is bounded on the way in — it reaches the model as one message.
 */
export function hostQuestionResultText(
  outcome:
    | { status: 'answered'; answer: string }
    | { status: 'declined' }
    | { status: 'posted' }
    | { status: 'unavailable'; reason: string },
): string {
  if (outcome.status === 'answered') {
    return `The user responded: ${outcome.answer.slice(0, MAX_ANSWER_LENGTH)}`;
  }
  if (outcome.status === 'declined') {
    return 'The user dismissed the question without answering. Continue without their answer, or ask again in your reply.';
  }
  if (outcome.status === 'posted') {
    return POSTED_QUESTION_RESULT;
  }
  return `The question could not be put to the user (${outcome.reason}). Ask in your reply instead.`;
}

/**
 * What the agent is told when the card is on screen and the answer will arrive
 * LATER, as the run's next message (`HostQuestionOutcome`'s `posted` arm).
 *
 * It has to do the work the blocking call used to do for free, so every clause
 * is answering a way the turn went wrong before it existed. **Stop** — the
 * model's own instinct is to carry on and guess, which makes the question
 * pointless. **Do not ask again** — a re-ask raises nothing new (the standing
 * card is adopted) and only spends a turn; this replaces the retry loop that
 * got reported, where an agent timed out twice and then wrote the options into
 * the chat as lettered choices. **The answer arrives as a message** — without
 * that the model reads its next user turn as a non sequitur rather than as the
 * reply to the card, which is the one thing it needs to know to use it.
 */
export const POSTED_QUESTION_RESULT =
  'The question is now on the user’s screen, waiting for them. STOP HERE and end your turn: do not answer it yourself, do not guess, and do not call this tool again for the same question — a repeat call raises no new card. When they answer, their reply arrives as your next user message; continue from there.';
