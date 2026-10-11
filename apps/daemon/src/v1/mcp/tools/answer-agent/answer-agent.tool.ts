import type { CallEnvelope } from '../../../graphs/graphs.types';
import type { McpCallContext } from '../../mcp.types';
import { CallMcpTool } from '../call-mcp-tool';
import { answerAgentInstructions } from './answer-agent.instructions';
import { validateAnswerAgentArgs } from './answer-agent.reader';
import { answerAgentSchema } from './answer-agent.schema';

/** `answer_agent` — answer a question one of this caller's callees parked. */
export class AnswerAgentTool extends CallMcpTool {
  readonly name = 'answer_agent';

  protected instructions(): string {
    return answerAgentInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return answerAgentSchema();
  }

  protected async envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope> {
    return (
      validateAnswerAgentArgs(args) ??
      this.calls.answerAgent(context.runId, context.caller, {
        call_id: args.call_id as string,
        answer: args.answer as string,
      })
    );
  }
}
