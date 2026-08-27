import {
  HOST_QUESTION_TOOL,
  type HostQuestion,
  MAX_ANSWER_LENGTH,
  MAX_HOST_QUESTION_OPTIONS,
  MAX_HOST_QUESTIONS,
  MAX_QUESTION_HEADER_LENGTH,
} from '../chat.types';

/**
 * The name geniro's own MCP server carries for one run.
 *
 * Per RUN — see `AgentTurnInput.mcpEndpoint.serverName` — and spelled here
 * because two things need it and they are in different modules: the turn that
 * hands the endpoint over, and the permission gate that has to recognise a
 * call BACK to it.
 */
export function hostMcpServerName(runId: string): string {
  return `geniro-${runId.slice(0, 8)}`;
}

/**
 * Whether a permission request names geniro's OWN question tool on geniro's
 * own server — the one call the daemon approves for the user.
 *
 * Approving it is not a permission being waived, it is a DOUBLE gate being
 * removed: what the agent is asking to run is the act of asking the user
 * something, and the user's real decision is the question card that follows.
 * Left un-approved, an `ask`-posture chat shows "may I ask you a question?"
 * and then asks the question — a press with nothing behind it.
 *
 * Matched on the server name geniro MINTED plus its own tool name, rather
 * than on the CLI's rendering of them: cursor sends the pair as one prose
 * label (`<server>: <tool>`), and a matcher written against that sentence
 * would silently stop recognising it the day the vendor changes the
 * separator. Requiring BOTH halves is what keeps a user's own server from
 * ever reaching this branch — the run's server name carries its run id, so no
 * other server can be named it.
 */
export function isHostQuestionCall(
  serverName: string | null,
  toolName: string,
): boolean {
  if (serverName === null) {
    return false;
  }
  return (
    toolName === HOST_QUESTION_TOOL ||
    (toolName.includes(serverName) && toolName.includes(HOST_QUESTION_TOOL))
  );
}

/**
 * Read an `ask_user_question` tool call's arguments into questions the card can
 * render.
 *
 * Defensive rather than schema-validating, on the same rule the adapters' own
 * question projections follow: the caller is a model, so a field can be
 * anything at all, and the honest answers are "here is what parsed" and "none
 * of it did" — never a throw across the transport. A question with no options
 * is DROPPED rather than rendered, because the card's whole affordance is
 * picking one, and an option-less question is a card with nothing to press.
 *
 * The caps bound what one call can put on screen. They TRUNCATE rather than
 * refuse: a model that sends nine options has still asked a real question, and
 * failing the call would leave it with no way to ask at all.
 */
export function readHostQuestions(
  args: Record<string, unknown>,
): HostQuestion[] {
  const raw = args.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: HostQuestion[] = [];
  for (const entry of raw.slice(0, MAX_HOST_QUESTIONS)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const q = entry as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    if (typeof q.question !== 'string' || q.question.trim().length === 0) {
      continue;
    }
    const options = (Array.isArray(q.options) ? q.options : [])
      .slice(0, MAX_HOST_QUESTION_OPTIONS)
      .flatMap((option): HostQuestion['options'] => {
        // A bare string is accepted beside the documented object: it is what a
        // model reaches for first, and refusing it would drop a whole question
        // over a shape nobody would notice was wrong.
        if (typeof option === 'string') {
          return option.trim().length > 0 ? [{ label: option }] : [];
        }
        if (typeof option !== 'object' || option === null) {
          return [];
        }
        const o = option as { label?: unknown; description?: unknown };
        if (typeof o.label !== 'string' || o.label.trim().length === 0) {
          return [];
        }
        return [
          {
            label: o.label,
            ...(typeof o.description === 'string' && o.description.length > 0
              ? { description: o.description }
              : {}),
          },
        ];
      });
    if (options.length === 0) {
      continue;
    }
    questions.push({
      question: q.question,
      ...(typeof q.header === 'string' &&
      q.header.length > 0 &&
      q.header.length <= MAX_QUESTION_HEADER_LENGTH
        ? { header: q.header }
        : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return questions;
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
    | { status: 'unavailable'; reason: string },
): string {
  if (outcome.status === 'answered') {
    return `The user responded: ${outcome.answer.slice(0, MAX_ANSWER_LENGTH)}`;
  }
  if (outcome.status === 'declined') {
    return 'The user dismissed the question without answering. Continue without their answer, or ask again in your reply.';
  }
  return `The question could not be put to the user (${outcome.reason}). Ask in your reply instead.`;
}
