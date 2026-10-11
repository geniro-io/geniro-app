import { HOST_FINDINGS_TOOL } from '../../../agents/chat.types';
import type { FindingsReportBroker } from '../../../agents/services/findings-report.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { reportFindingsInstructions } from './report-findings.instructions';
import {
  hostFindingsResultText,
  readHostFindingsReport,
} from './report-findings.reader';
import { reportFindingsSchema } from './report-findings.schema';

/** `report_findings` — hand code-review findings over as a list this app draws. */
export class ReportFindingsTool extends BaseMcpTool {
  readonly name = HOST_FINDINGS_TOOL;

  constructor(private readonly findings: FindingsReportBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.findings.canReport(runId, nodeId);
  }

  protected instructions(): string {
    return reportFindingsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return reportFindingsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    // Its own shape, for the question tool's reason: a card drawn in this
    // app's transcript has no status and nothing to collect later.
    if (!Array.isArray(args.findings)) {
      return this.invalidArgs(
        "'findings' must be an array — pass an empty one to report that nothing survived verification.",
      );
    }
    const report = readHostFindingsReport(args);
    // A non-empty array that parsed to nothing is a malformed call, not an
    // empty report, and the two must not answer alike: told "0 findings
    // recorded" the model believes it has reported and moves on, when in
    // fact every finding it found was dropped at this edge.
    if (args.findings.length > 0 && report.findings.length === 0) {
      return this.invalidArgs(
        "no finding could be read — each entry needs a 'file' and a 'summary' string.",
      );
    }
    const outcome = await this.findings.report(runId, nodeId, report);
    // An unavailable channel is an answer the agent carries on from —
    // it still holds the findings and can write them in its reply.
    return this.text(hostFindingsResultText(outcome));
  }
}
