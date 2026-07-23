import { withResponse } from '../adapters/claude/question-payload';

/**
 * True when a card verdict's optional free-text `answer` is actually applied
 * to the tool input. Shared by the graph executor and the chat service (the
 * two approval-card producers) so the transcript-recording condition can
 * never drift from the fold condition.
 */
export function answerFoldsInto(
  toolName: string,
  allow: boolean,
  answer: string | undefined,
): answer is string {
  return allow && answer !== undefined && toolName === 'AskUserQuestion';
}

/**
 * The one place a verdict's answer may mutate a tool input: it folds ONLY
 * into AskUserQuestion (the probe-verified `updatedInput.response` free-text
 * channel) — every other tool echoes its input unchanged, so the verdict
 * channel can never rewrite an arbitrary tool's arguments.
 */
export function foldApprovalAnswer(
  toolName: string,
  input: unknown,
  allow: boolean,
  answer: string | undefined,
): unknown {
  return answerFoldsInto(toolName, allow, answer)
    ? withResponse(input, answer)
    : input;
}
