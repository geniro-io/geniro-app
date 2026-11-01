import type { CallEnvelope } from '../../../teams/teams.types';
import type { McpCallContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { listAgentThreadsInstructions } from './list-agent-threads.instructions';
import { validateListAgentThreadsArgs } from './list-agent-threads.reader';
import { listAgentThreadsSchema } from './list-agent-threads.schema';

/**
 * `list_agent_threads` — this caller's conversations, each with where its
 * prompt cache stands, so it can choose between continuing one and starting
 * a fresh instance.
 */
export class ListAgentThreadsTool extends CallMcpTool {
  readonly name = 'list_agent_threads';

  protected instructions(): string {
    return listAgentThreadsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return listAgentThreadsSchema();
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    return (
      validateListAgentThreadsArgs(args) ??
      this.calls.listThreads(context.runId, context.caller)
    );
  }
}
