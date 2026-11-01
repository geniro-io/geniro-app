import type { CallEnvelope } from '../../../teams/teams.types';
import { unknownArgsEnvelope } from '../call-mcp-tool';

/** `list_agent_threads` reads no argument — see `call-agent.reader.ts`. */
const LIST_AGENT_THREADS_ARGS: string[] = [];

export function validateListAgentThreadsArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  return unknownArgsEnvelope(args, LIST_AGENT_THREADS_ARGS);
}
