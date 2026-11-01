import { HOST_COMPARISON_TOOL } from '../../../agents/chat.types';
import type { ComparisonBroker } from '../../../agents/services/comparison.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showComparisonInstructions } from './show-comparison.instructions';
import {
  hostComparisonResultText,
  readHostComparison,
} from './show-comparison.reader';
import { showComparisonSchema } from './show-comparison.schema';

/** `show_comparison` — options judged side by side against the same criteria. */
export class ShowComparisonTool extends BaseMcpTool {
  readonly name = HOST_COMPARISON_TOOL;

  constructor(private readonly comparisons: ComparisonBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.comparisons.canDraw(runId, memberId);
  }

  protected instructions(): string {
    return showComparisonInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showComparisonSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const comparison = readHostComparison(args);
    // Null is the reader saying there is nothing to compare — fewer than
    // two options, or no criterion. Answered as a malformed call on the
    // chart's rule: an empty findings report is a real review outcome, a
    // comparison of one thing is only ever a mistake.
    if (comparison === null) {
      return this.invalidArgs(
        "nothing to compare — needs a 'title', at least TWO entries in 'options' each with a 'name', and at least one entry in 'criteria' with a 'label'.",
      );
    }
    const outcome = await this.comparisons.draw(runId, memberId, comparison);
    // Same reading as its drawing siblings: an unavailable channel is an
    // answer, not a failure — the agent still holds the comparison.
    return this.text(hostComparisonResultText(outcome));
  }
}
