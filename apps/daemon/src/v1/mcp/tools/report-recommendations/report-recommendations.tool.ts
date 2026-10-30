import { HOST_RECOMMENDATIONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { MemoryService } from '../../../memory/services/memory.service';
import type { WorkflowHistoryService } from '../../../stats/services/workflow-history.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { reportRecommendationsInstructions } from './report-recommendations.instructions';
import {
  readRecommendationsReport,
  recommendationsResultText,
} from './report-recommendations.reader';
import { reportRecommendationsSchema } from './report-recommendations.schema';

/** `report_recommendations` — an analysis's selectable recommendations card. */
export class ReportRecommendationsTool extends BaseMcpTool {
  readonly name = HOST_RECOMMENDATIONS_TOOL;

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly memory: Pick<MemoryService, 'enabled'>,
    private readonly history: Pick<WorkflowHistoryService, 'versionIndex'>,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.analysis.canAnalyse(runId, nodeId);
  }

  protected instructions(): string {
    return reportRecommendationsInstructions(this.memory.enabled);
  }

  protected inputSchema(): Record<string, unknown> {
    return reportRecommendationsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readRecommendationsReport(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const result = recommendationsResultText(
      await this.analysis.report(runId, nodeId, read.query, (slug) =>
        this.history.versionIndex(slug),
      ),
    );
    return this.text(result.text, result.isError);
  }
}
