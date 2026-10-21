import { maskWhile, registerSecret } from '../../diagnostics/utils/redact';
import type { ApprovalOption, CardQuestion } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { asksForSecret, secretAnswerParts } from './card-questions';

/**
 * The question/answer seam shared by the two approval-card producers (the
 * graph executor and the chat service).
 *
 * None of these helpers knows a CLI's tool names or payload shapes: the caller
 * passes the question tool its adapter declares
 * (`AgentAdapter.getConfig().questionToolName`), which is `null` for a CLI with no
 * question channel, and the fold itself is handed back to that adapter
 * (`AgentAdapter.withAnswer`). That keeps every CLI-specific fact in the
 * adapter layer while the seam itself stays shared, so the recording condition
 * can never drift from the fold condition.
 */

/**
 * True when an approval request is a genuine USER QUESTION rather than a
 * permission check — the single discriminator behind "render a question card"
 * and "the daemon may auto-approve this".
 *
 * Deliberately keyed on the tool NAME, not on the CLI's own
 * `requires_user_interaction` flag: a future interactive tool must not be able
 * to slip past a human gate through version drift. Callers that see the flag
 * on an unrecognized tool should log it, and keep the request on the approval
 * path.
 */
export function isUserQuestion(
  questionToolName: string | null,
  toolName: string,
): boolean {
  return questionToolName !== null && toolName === questionToolName;
}

/**
 * True when a card verdict's optional free-text `answer` is actually applied
 * to the tool input.
 */
export function answerFoldsInto(
  questionToolName: string | null,
  toolName: string,
  allow: boolean,
  answer: string | undefined,
): answer is string {
  return (
    allow && answer !== undefined && isUserQuestion(questionToolName, toolName)
  );
}

/** The label a secret answer is masked as in the debug log. */
const SECRET_ANSWER_LABEL = 'secret answer';

/**
 * The shortest secret answer that is masked at all. Under four characters,
 * masking would blank common tokens even inside the one frame it guards, to
 * hide what a guess would find anyway.
 */
const MIN_SECRET_ANSWER_LENGTH = 4;

/** What a verdict row records about the remembering option the user picked. */
export interface VerdictOptionRecord {
  id: string;
  label: string;
  scope: ApprovalOption['scope'];
}

/**
 * The request's own option a verdict names, or undefined for a one-time
 * answer.
 *
 * Read off the REQUEST, never taken from the client: the card can only name an
 * id the adapter offered, and an option must point the same way as the verdict
 * it rides — an "always allow" id on a Deny is a client bug, answered as the
 * plain Deny it was pressed as rather than as a standing permission.
 */
export function pickedApprovalOption(
  options: readonly ApprovalOption[] | undefined,
  allow: boolean,
  optionId: string | undefined,
): ApprovalOption | undefined {
  if (optionId === undefined) {
    return undefined;
  }
  return options?.find(
    (option) => option.id === optionId && option.allow === allow,
  );
}

/**
 * Deliver a card verdict to the CLI (`deliver` is handed the input it should
 * carry, and the picked option when there is one) and say what its
 * `approval_verdict` row may record.
 *
 * The answer folds ONLY into the CLI's question tool: every other tool echoes
 * its input unchanged, so the verdict channel can never rewrite an arbitrary
 * tool's arguments. WHERE it lands inside that input is the adapter's own
 * knowledge (`withAnswer`). The row records the answer when it folded, so the
 * transcript never claims one the agent did not receive — and none of it when
 * the card marked a question secret: the row is SQLite and replays to every
 * client, while a secret belongs to the agent alone.
 *
 * `optionId` names one of the request's own `options` (see
 * {@link pickedApprovalOption}); the row records the option the CLI was
 * actually sent, so a settled card says how long the answer lasts.
 *
 * A secret answer is kept out of the debug log, whose raw stdio channel
 * records the frame that carries it. A value long enough to mask everywhere is
 * registered for good; a shorter one — a PIN, a short password — is masked
 * only while `deliver` writes it (`maskWhile`), because masked everywhere it
 * would be given away by the coincidences it blanks. That is why this takes
 * the delivery rather than handing the input back for the caller to send.
 *
 * Only a card a CLI's own question tool produced can be marked secret: the
 * host `ask_user_question` tool has no such flag, and its answers go through
 * the chat service's own host-question writers.
 */
export function deliverApprovalAnswer(
  adapter: AgentAdapter,
  request: {
    toolName: string;
    input: unknown;
    questions?: readonly CardQuestion[];
    options?: readonly ApprovalOption[];
  },
  allow: boolean,
  answer: string | undefined,
  deliver: (input: unknown, option?: ApprovalOption) => boolean,
  optionId?: string,
): {
  delivered: boolean;
  record: { answer?: string; option?: VerdictOptionRecord };
} {
  const questionToolName = adapter.getConfig().questionToolName;
  if (!answerFoldsInto(questionToolName, request.toolName, allow, answer)) {
    const option = pickedApprovalOption(request.options, allow, optionId);
    if (option === undefined) {
      return { delivered: deliver(request.input), record: {} };
    }
    return {
      delivered: deliver(request.input, option),
      record: {
        option: { id: option.id, label: option.label, scope: option.scope },
      },
    };
  }
  const input = adapter.withAnswer(request.input, answer);
  if (!asksForSecret(request.questions)) {
    return { delivered: deliver(input), record: { answer } };
  }
  const short: string[] = [];
  // As typed, and as it sits inside the JSON frame that carries it to the CLI:
  // escaping rewrites a quote, a backslash or a line break, and the stdio
  // channel records the frame.
  for (const value of secretAnswerParts(answer, request.questions ?? [])) {
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
      if (
        !registerSecret(form, SECRET_ANSWER_LABEL) &&
        form.trim().length >= MIN_SECRET_ANSWER_LENGTH
      ) {
        short.push(form);
      }
    }
  }
  return {
    delivered: maskWhile(short, SECRET_ANSWER_LABEL, () => deliver(input)),
    record: {},
  };
}
