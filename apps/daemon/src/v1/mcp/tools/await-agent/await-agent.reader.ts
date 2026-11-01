import {
  type CallEnvelope,
  MAX_AWAIT_TIMEOUT_MS,
  MIN_AWAIT_TIMEOUT_MS,
} from '../../../teams/teams.types';
import { invalidArgsEnvelope, unknownArgsEnvelope } from '../call-mcp-tool';

/** Every argument `await_agent` reads — see `call-agent.reader.ts`. */
const AWAIT_AGENT_ARGS = ['call_id', 'timeout_ms'];

export function validateAwaitAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  const unknown = unknownArgsEnvelope(args, AWAIT_AGENT_ARGS);
  if (unknown) {
    return unknown;
  }
  if (
    args.call_id !== undefined &&
    (typeof args.call_id !== 'string' || args.call_id.length === 0)
  ) {
    return invalidArgsEnvelope(
      "'call_id' must be a non-empty string, or omitted to wait on all of your calls",
    );
  }
  if (args.timeout_ms !== undefined) {
    // Integer-checked rather than merely numeric: `setTimeout` takes a
    // fractional or non-finite delay without complaint and fires immediately,
    // so a NaN — which is what a model's "5 seconds" parses to — would answer
    // `pending` on every call and read as a callee that never progresses.
    if (
      typeof args.timeout_ms !== 'number' ||
      !Number.isInteger(args.timeout_ms) ||
      args.timeout_ms < MIN_AWAIT_TIMEOUT_MS ||
      args.timeout_ms > MAX_AWAIT_TIMEOUT_MS
    ) {
      return invalidArgsEnvelope(
        `'timeout_ms' must be a whole number of milliseconds between ${MIN_AWAIT_TIMEOUT_MS} and ${MAX_AWAIT_TIMEOUT_MS}`,
      );
    }
  }
  return null;
}
