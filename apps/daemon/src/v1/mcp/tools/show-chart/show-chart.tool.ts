import { HOST_CHART_TOOL } from '../../../agents/chat.types';
import type { ChartBroker } from '../../../agents/services/chart.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showChartInstructions } from './show-chart.instructions';
import { hostChartResultText, readHostChart } from './show-chart.reader';
import { showChartSchema } from './show-chart.schema';

/** `show_chart` — plot several readings of one thing as a chart. */
export class ShowChartTool extends BaseMcpTool {
  readonly name = HOST_CHART_TOOL;

  constructor(private readonly charts: ChartBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.charts.canDraw(runId, memberId);
  }

  protected instructions(): string {
    return showChartInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showChartSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const chart = readHostChart(args);
    // Null is the reader saying there is nothing plottable here at all.
    // Unlike an empty findings report — which is a real review outcome — a
    // chart of nothing is only ever a mistake, so it is answered as a
    // malformed call rather than as a drawn chart with no data.
    if (chart === null) {
      return this.invalidArgs(
        "nothing plottable — 'labels' must be a non-empty array, and 'series' must hold at least one entry with a 'name' and one measured number in 'values'.",
      );
    }
    const outcome = await this.charts.draw(runId, memberId, chart);
    // Same reading as the findings tool: an unavailable channel is an
    // answer, not a failure — the agent still holds the numbers.
    return this.text(hostChartResultText(outcome));
  }
}
