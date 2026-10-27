import { Logger } from '@nestjs/common';

import { HOST_BACKUP_WORKFLOW_TOOL } from '../../../agents/chat.types';
import type { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
import type { WorkflowChangeService } from '../../../graphs/services/workflow-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { backupWorkflowInstructions } from './backup-workflow.instructions';
import {
  backupResultText,
  readBackupWorkflowArgs,
} from './backup-workflow.reader';
import { backupWorkflowSchema } from './backup-workflow.schema';

/**
 * `backup_workflow` — a workflow builder chat's backup of its own file, taken
 * when the user asks for one; an approved `propose_workflow` card takes its
 * own before it saves.
 */
export class BackupWorkflowTool extends BaseMcpTool {
  readonly name = HOST_BACKUP_WORKFLOW_TOOL;
  private readonly logger = new Logger(BackupWorkflowTool.name);

  constructor(
    private readonly builders: WorkflowBuilderBroker,
    private readonly workflows: WorkflowChangeService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.builders.canEdit(runId, nodeId);
  }

  protected instructions(): string {
    return backupWorkflowInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return backupWorkflowSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readBackupWorkflowArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.builders.workflowOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Nothing backed up: ${turn.reason}.`, true);
    }
    try {
      const result = backupResultText(await this.workflows.backUp(turn.slug));
      return this.text(result.text, result.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not back up a workflow: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — nothing was backed up.`,
        true,
      );
    }
  }
}
