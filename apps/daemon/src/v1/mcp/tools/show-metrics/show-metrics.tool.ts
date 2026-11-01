import { HOST_METRICS_TOOL } from '../../../agents/chat.types';
import type { MetricsBroker } from '../../../agents/services/metrics.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showMetricsInstructions } from './show-metrics.instructions';
import { hostMetricsResultText, readHostMetrics } from './show-metrics.reader';
import { showMetricsSchema } from './show-metrics.schema';

/** `show_metrics` — a few headline figures as a scorecard. */
export class ShowMetricsTool extends BaseMcpTool {
  readonly name = HOST_METRICS_TOOL;

  constructor(private readonly metrics: MetricsBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.metrics.canDraw(runId, memberId);
  }

  protected instructions(): string {
    return showMetricsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showMetricsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const metrics = readHostMetrics(args);
    // Null is the reader saying there is no figure here at all, answered as
    // a malformed call for the CHART's reason rather than the findings
    // tool's: an empty findings report is a real review outcome, while a
    // scorecard with nothing on it is only ever a mistake, and answering it
    // as drawn would have the agent believe its numbers are on screen.
    if (metrics === null) {
      return this.invalidArgs(
        "no figure could be read — 'metrics' must be a non-empty array, and each entry needs a 'label' and a 'value', both STRINGS (format the number yourself: \"82%\", not 0.82).",
      );
    }
    const outcome = await this.metrics.draw(runId, memberId, metrics);
    // Same reading as its drawing siblings: an unavailable channel is an
    // answer, not a failure — the agent still holds the figures.
    return this.text(hostMetricsResultText(outcome));
  }
}
