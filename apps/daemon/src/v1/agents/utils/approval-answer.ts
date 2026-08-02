import type { AgentAdapter } from '../adapters/agent-adapter';

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

/**
 * The one place a verdict's answer may mutate a tool input: it folds ONLY
 * into the CLI's question tool — every other tool echoes its input unchanged,
 * so the verdict channel can never rewrite an arbitrary tool's arguments.
 *
 * WHERE the answer lands inside that input is the adapter's own knowledge
 * (`withAnswer`), so this seam names no CLI's field: what it owns is the
 * CONDITION, shared with `answerFoldsInto` so the transcript can never claim
 * an answer the agent did not receive.
 */
export function foldApprovalAnswer(
  adapter: AgentAdapter,
  toolName: string,
  input: unknown,
  allow: boolean,
  answer: string | undefined,
): unknown {
  return answerFoldsInto(
    adapter.getConfig().questionToolName,
    toolName,
    allow,
    answer,
  )
    ? adapter.withAnswer(input, answer)
    : input;
}
