import { Logger } from '@nestjs/common';

import { HOST_WORKFLOW_CHANGE_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ThreadReaderService } from '../../../agents/services/thread-reader.service';
import type { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
import type {
  WorkflowChange,
  WorkflowChangeService,
} from '../../../graphs/services/workflow-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { saveWorkflowChangeInstructions } from './save-workflow-change.instructions';
import {
  readBuilderWorkflowChangeArgs,
  readSaveWorkflowChangeArgs,
  workflowChangeResultText,
} from './save-workflow-change.reader';
import { saveWorkflowChangeSchema } from './save-workflow-change.schema';

/**
 * `save_workflow_change` — an analysis's one write to the workflow library,
 * through `WorkflowChangeService`'s checks and its timed backup. It is not
 * auto-approved: outside `auto` the user confirms the write as well as the
 * Apply that asked for it. A workflow's own builder chat gets it as a check
 * that writes nothing (its change is written behind `propose_workflow`'s
 * card), approved without asking (`isHostBuilderWorkflowCall`).
 */
export class SaveWorkflowChangeTool extends BaseMcpTool {
  readonly name = HOST_WORKFLOW_CHANGE_TOOL;
  private readonly logger = new Logger(SaveWorkflowChangeTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly builders: WorkflowBuilderBroker,
    private readonly threads: ThreadReaderService,
    private readonly workflows: WorkflowChangeService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return (
      this.analysis.canAnalyse(runId, nodeId) ||
      this.builders.canEdit(runId, nodeId)
    );
  }

  protected instructions({ runId, nodeId }: McpListContext): string {
    return saveWorkflowChangeInstructions(this.builders.canEdit(runId, nodeId));
  }

  protected inputSchema({
    runId,
    nodeId,
  }: McpListContext): Record<string, unknown> {
    return saveWorkflowChangeSchema(this.builders.canEdit(runId, nodeId));
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        'Nothing saved: no turn is running that may change a workflow.',
        true,
      );
    }
    return this.builders.canEdit(runId, nodeId)
      ? this.saveForBuilder(args, runId, nodeId)
      : this.saveForAnalysis(args, runId, nodeId);
  }

  private async saveForBuilder(
    args: Record<string, unknown>,
    runId: string,
    nodeId: string,
  ): Promise<McpToolResult> {
    const read = readBuilderWorkflowChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.builders.workflowOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    return this.save(
      runId,
      {
        authority: {
          kind: 'builder',
          savedHash: turn.savedHash,
          turnStartedAt: turn.turnStartedAt,
          acceptsAnyVersion: turn.acceptsAnyVersion,
        },
        slug: turn.slug,
        edits: read.query.edits,
        // A builder chat's change is written behind `propose_workflow`'s
        // card, never by this call.
        dryRun: true,
      },
      // The turn's next check is held to the version this one read, or a
      // refusal for a changed file found (which the agent is told to read
      // again) — or, after a refusal for a file that cannot be loaded, to
      // nothing: the agent repairs it itself.
      (answer) => {
        if (answer.error === 'WORKFLOW_UNREADABLE') {
          return this.builders.noteVersion(runId, nodeId, turn.turnStartedAt, {
            savedHash: null,
            acceptsAnyVersion: true,
          });
        }
        const known = answer.currentHash;
        return typeof known === 'string'
          ? this.builders.noteVersion(runId, nodeId, turn.turnStartedAt, {
              savedHash: known,
              acceptsAnyVersion: false,
            })
          : Promise.resolve();
      },
    );
  }

  private async saveForAnalysis(
    args: Record<string, unknown>,
    runId: string,
    nodeId: string,
  ): Promise<McpToolResult> {
    const read = readSaveWorkflowChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    let workflow: Awaited<
      ReturnType<ThreadReaderService['analysedWorkflowOf']>
    >;
    try {
      workflow = await this.threads.analysedWorkflowOf(turn);
    } catch (error) {
      return this.failed(runId, error);
    }
    if (workflow === null) {
      return this.text(
        'NOT_A_WORKFLOW: the analysed thread is a plain chat (or is gone) — it has no workflow to change.',
        true,
      );
    }
    return this.save(runId, {
      authority: {
        kind: 'apply',
        analysisRunId: turn.analysisRunId,
        ids: read.query.ids,
        baseHash: read.query.baseHash,
      },
      slug: workflow.slug,
      edits: read.query.edits,
      dryRun: read.query.dryRun ?? false,
    });
  }

  private async save(
    runId: string,
    change: WorkflowChange,
    onAnswer: (answer: Record<string, unknown>) => Promise<void> = () =>
      Promise.resolve(),
  ): Promise<McpToolResult> {
    try {
      const answer = await this.workflows.save(change);
      await onAnswer(answer);
      const result = workflowChangeResultText(answer);
      return this.text(result.text, result.isError);
    } catch (error) {
      return this.failed(runId, error);
    }
  }

  private failed(runId: string, error: unknown): McpToolResult {
    this.logger.error(
      `run ${runId} could not save a workflow change: ${error instanceof Error ? error.message : String(error)}`,
    );
    return this.text(
      `${this.name} failed internally — nothing was saved. Report this item as failed.`,
      true,
    );
  }
}
