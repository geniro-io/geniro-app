import type { CallEnvelope } from '../../../graphs/graphs.types';
import { invalidArgsEnvelope, unknownArgsEnvelope } from '../call-mcp-tool';

/**
 * How long a `cancel_agent` reason may be. Short on purpose: it is one sentence
 * on a transcript row and inside an error envelope, not a report — the account
 * of what went wrong belongs in the caller's own message to the user.
 */
export const MAX_CANCEL_REASON_LENGTH = 400;

/** Every argument `cancel_agent` reads — see `call-agent.reader.ts`. */
const CANCEL_AGENT_ARGS = ['call_id', 'reason'];

export function validateCancelAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  const unknown = unknownArgsEnvelope(args, CANCEL_AGENT_ARGS);
  if (unknown) {
    return unknown;
  }
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgsEnvelope("'call_id' must be a non-empty string");
  }
  // REQUIRED, not optional: the reason is the whole record of a call ending
  // early, and an optional field would routinely be omitted.
  if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
    return invalidArgsEnvelope(
      "'reason' must be a non-empty string — say why this call is no longer worth finishing",
    );
  }
  if (args.reason.length > MAX_CANCEL_REASON_LENGTH) {
    return invalidArgsEnvelope(
      `'reason' exceeds ${MAX_CANCEL_REASON_LENGTH} characters — one sentence is enough`,
    );
  }
  return null;
}
