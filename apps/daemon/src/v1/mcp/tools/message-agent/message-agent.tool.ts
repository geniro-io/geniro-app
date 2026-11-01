import type { CallEnvelope } from '../../../teams/teams.types';
import type { McpCallContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { messageAgentInstructions } from './message-agent.instructions';
import { validateMessageAgentArgs } from './message-agent.reader';
import { messageAgentSchema } from './message-agent.schema';

/** `message_agent` — steer one of this caller's running calls. */
export class MessageAgentTool extends CallMcpTool {
  readonly name = 'message_agent';

  protected instructions(): string {
    return messageAgentInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return messageAgentSchema();
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    return (
      validateMessageAgentArgs(args) ??
      this.calls.messageAgent(context.runId, context.caller, {
        call_id: args.call_id as string,
        message: args.message as string,
      })
    );
  }
}
