import type { CallEnvelope } from '../../../graphs/graphs.types';
import type { McpCallContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { cancelAgentInstructions } from './cancel-agent.instructions';
import { validateCancelAgentArgs } from './cancel-agent.reader';
import { cancelAgentSchema } from './cancel-agent.schema';

/** `cancel_agent` — stop one of this caller's calls that is no longer worth finishing. */
export class CancelAgentTool extends CallMcpTool {
  readonly name = 'cancel_agent';

  protected instructions(): string {
    return cancelAgentInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return cancelAgentSchema();
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    return (
      validateCancelAgentArgs(args) ??
      this.calls.cancelAgent(context.runId, context.caller, {
        call_id: args.call_id as string,
        reason: (args.reason as string).trim(),
      })
    );
  }
}
