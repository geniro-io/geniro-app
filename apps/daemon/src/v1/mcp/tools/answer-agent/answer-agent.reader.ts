import { MAX_ANSWER_LENGTH } from '../../../agents/chat.types';
import type { CallEnvelope } from '../../../teams/teams.types';
import { invalidArgsEnvelope, unknownArgsEnvelope } from '../call-mcp-tool';

/** Every argument `answer_agent` reads — see `call-agent.reader.ts`. */
const ANSWER_AGENT_ARGS = ['call_id', 'answer'];

export function validateAnswerAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  const unknown = unknownArgsEnvelope(args, ANSWER_AGENT_ARGS);
  if (unknown) {
    return unknown;
  }
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgsEnvelope("'call_id' must be a non-empty string");
  }
  if (typeof args.answer !== 'string' || args.answer.trim().length === 0) {
    return invalidArgsEnvelope("'answer' must be a non-empty string");
  }
  if (args.answer.length > MAX_ANSWER_LENGTH) {
    return invalidArgsEnvelope(
      `'answer' exceeds ${MAX_ANSWER_LENGTH} characters — summarize it`,
    );
  }
  return null;
}
