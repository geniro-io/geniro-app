import type { CallEnvelope, CallMode } from '../../../teams/teams.types';
import {
  CALLEE_DESCRIPTION_MAX,
  calleeSummary,
} from '../../../teams/utils/callee-text';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { callAgentInstructions } from './call-agent.instructions';
import { poolMemberArg, validateCallAgentArgs } from './call-agent.reader';
import { callAgentSchema } from './call-agent.schema';

/** `call_agent` — invoke one of this node's call-wired agents. */
export class CallAgentTool extends CallMcpTool {
  readonly name = 'call_agent';

  protected instructions({
    runId,
    nodeId,
    conversationId,
  }: McpListContext): string {
    // Each callee's own description is the routing signal — pick the agent
    // whose blurb matches the task, no hand-written roster in your role.
    const callable =
      this.calls
        .listCallees(runId, nodeId)
        .map((callee) => calleeSummary(callee, CALLEE_DESCRIPTION_MAX))
        .join('; ') || 'none';
    return callAgentInstructions(callable, conversationId !== null);
  }

  protected inputSchema(): Record<string, unknown> {
    return callAgentSchema();
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    const checked = validateCallAgentArgs(args);
    if (typeof checked !== 'string') {
      return checked;
    }
    return this.waiting(context, (signal) =>
      this.calls.callAgent(
        context.runId,
        context.caller,
        {
          agent: args.agent as string,
          message: args.message as string,
          title: checked,
          mode: args.mode as CallMode | undefined,
          thread: args.thread as string | undefined,
          ...(args.resume_cold === true ? { resumeCold: true } : {}),
          ...(args.member !== undefined
            ? { member: poolMemberArg(args.member)! }
            : {}),
        },
        signal,
      ),
    );
  }
}
