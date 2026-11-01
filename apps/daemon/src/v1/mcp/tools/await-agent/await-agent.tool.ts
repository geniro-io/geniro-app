import {
  type CallEnvelope,
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
} from '../../../teams/teams.types';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { awaitAgentInstructions } from './await-agent.instructions';
import { validateAwaitAgentArgs } from './await-agent.reader';
import { awaitAgentSchema } from './await-agent.schema';

/** `await_agent` — collect the result of one of this caller's calls. */
export class AwaitAgentTool extends CallMcpTool {
  readonly name = 'await_agent';

  protected instructions(): string {
    return awaitAgentInstructions();
  }

  protected inputSchema({
    runId,
    memberId,
  }: McpListContext): Record<string, unknown> {
    // The window THIS caller's waits actually get — below its own CLI's
    // tool-call deadline — so the listing does not promise a cursor caller
    // the 240s a claude caller has. A larger `timeout_ms` is not refused:
    // the broker caps it, and the wait simply answers `pending` sooner.
    const waitWindow = Math.min(
      MAX_AWAIT_TIMEOUT_MS,
      this.calls.waitCeiling(runId, memberId) ?? MAX_AWAIT_TIMEOUT_MS,
    );
    return awaitAgentSchema(waitWindow);
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    return (
      validateAwaitAgentArgs(args) ??
      (await this.waiting(context, (signal) =>
        this.calls.awaitAgent(
          context.runId,
          context.caller,
          {
            call_id: args.call_id as string | undefined,
            timeout_ms:
              (args.timeout_ms as number | undefined) ??
              DEFAULT_AWAIT_TIMEOUT_MS,
          },
          signal,
        ),
      ))
    );
  }
}
