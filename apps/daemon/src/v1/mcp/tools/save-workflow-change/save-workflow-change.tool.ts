import { Logger } from '@nestjs/common';

import { HOST_WORKFLOW_CHANGE_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ThreadReaderService } from '../../../agents/services/thread-reader.service';
import type { WorkflowChangeService } from '../../../graphs/services/workflow-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { saveWorkflowChangeInstructions } from './save-workflow-change.instructions';
import {
  readSaveWorkflowChangeArgs,
  workflowChangeResultText,
} from './save-workflow-change.reader';
import { saveWorkflowChangeSchema } from './save-workflow-change.schema';

/**
 * `save_workflow_change` — an analysis's one write to the workflow library,
 * through `WorkflowChangeService`'s checks and timed backup. Not
 * auto-approved: outside `auto` the user confirms the write as well as the
 * Apply that selected it.
 */
export class SaveWorkflowChangeTool extends BaseMcpTool {
  readonly name = HOST_WORKFLOW_CHANGE_TOOL;
  private readonly logger = new Logger(SaveWorkflowChangeTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly threads: ThreadReaderService,
    private readonly workflows: WorkflowChangeService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.analysis.canAnalyse(runId, nodeId);
  }

  protected instructions(): string {
    return saveWorkflowChangeInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return saveWorkflowChangeSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readSaveWorkflowChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    try {
      const workflow = await this.threads.workflowOf(turn.sourceRunId);
      if (workflow === null) {
        return this.text(
          'NOT_A_WORKFLOW: the analysed thread is a plain chat (or is gone) — it has no workflow to change.',
          true,
        );
      }
      const result = workflowChangeResultText(
        await this.workflows.save({
          analysisRunId: turn.analysisRunId,
          slug: workflow.slug,
          edits: read.query.edits,
          baseHash: read.query.baseHash,
          ids: read.query.ids,
          dryRun: read.query.dryRun ?? false,
        }),
      );
      return this.text(result.text, result.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not save a workflow change: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — nothing was saved. Report this item as failed.`,
        true,
      );
    }
  }
}
