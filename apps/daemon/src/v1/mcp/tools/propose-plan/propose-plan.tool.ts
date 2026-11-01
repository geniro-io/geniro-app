import { HOST_PLAN_TOOL } from '../../../agents/chat.types';
import type { PlanBroker } from '../../../agents/services/plan.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposePlanInstructions } from './propose-plan.instructions';
import { hostPlanResultText, readHostPlan } from './propose-plan.reader';
import { proposePlanSchema } from './propose-plan.schema';

/** `propose_plan` — a plan the user approves before the work starts. */
export class ProposePlanTool extends BaseMcpTool {
  readonly name = HOST_PLAN_TOOL;

  constructor(private readonly plans: PlanBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.plans.canPropose(runId, memberId);
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return proposePlanInstructions(this.plans.answersAtOnce(runId, memberId));
  }

  protected inputSchema(): Record<string, unknown> {
    return proposePlanSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const read = readHostPlan(args);
    // A sentence, like the patch reader's: every refusal here names
    // something the agent can fix and send again.
    if (!read.ok) {
      return this.invalidArgs(read.reason);
    }
    // BLOCKS until the user answers the card, like `propose_patch` and
    // `ask_user_question` and unlike the two drawing tools — unless this CLI
    // will not hold the call open, when the sink answers `posted` at once and
    // the verdict arrives as the run's next message.
    const outcome = await context.whileCancellable((signal) =>
      this.plans.propose(runId, memberId, read.plan, signal),
    );
    // A rejection is not a tool failure: the user exercised the gate this
    // tool exists to offer them, and flagging it as an error is how a
    // model comes to re-propose a plan that was just turned down.
    return this.text(hostPlanResultText(outcome));
  }
}
