import { HOST_MILESTONE_TOOL } from '../../../agents/chat.types';
import type { MilestoneBroker } from '../../../agents/services/milestone.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { milestoneInstructions } from './milestone.instructions';
import { milestoneResultText, readMilestone } from './milestone.reader';
import { milestoneSchema } from './milestone.schema';

/** `milestone` — record one important step of the work on the thread's timeline. */
export class MilestoneTool extends BaseMcpTool {
  readonly name = HOST_MILESTONE_TOOL;

  constructor(private readonly milestones: MilestoneBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.milestones.canUse(runId, memberId);
  }

  protected instructions(): string {
    return milestoneInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return milestoneSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readMilestone(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.milestones.record(
      runId,
      memberId,
      caller,
      input,
    );
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(milestoneResultText(outcome));
  }
}
