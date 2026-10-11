import { MAX_ANSWER_LENGTH } from '../../../agents/chat.types';
import type { CallEnvelope } from '../../../graphs/graphs.types';
import { invalidArgsEnvelope, unknownArgsEnvelope } from '../call-mcp-tool';

/** Every argument `message_agent` reads — see `call-agent.reader.ts`. */
const MESSAGE_AGENT_ARGS = ['call_id', 'message'];

export function validateMessageAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  const unknown = unknownArgsEnvelope(args, MESSAGE_AGENT_ARGS);
  if (unknown) {
    return unknown;
  }
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgsEnvelope("'call_id' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || args.message.trim().length === 0) {
    return invalidArgsEnvelope("'message' must be a non-empty string");
  }
  // The answer's bound: both are text the caller writes into a callee's turn.
  if (args.message.length > MAX_ANSWER_LENGTH) {
    return invalidArgsEnvelope(
      `'message' exceeds ${MAX_ANSWER_LENGTH} characters — summarize it, or point at a file`,
    );
  }
  return null;
}
