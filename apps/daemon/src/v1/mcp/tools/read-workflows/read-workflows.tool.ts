import { Logger } from '@nestjs/common';
import { BaseException } from '@packages/common';

import { HOST_READ_WORKFLOWS_TOOL } from '../../../agents/chat.types';
import type { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
import type { WorkflowProposalBroker } from '../../../agents/services/workflow-proposal.broker';
import type { WorkflowStoreService } from '../../../graphs/services/workflow-store.service';
import { firstLineOf } from '../../../graphs/utils/config-dir-redaction';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readWorkflowsInstructions } from './read-workflows.instructions';
import {
  readReadWorkflowsArgs,
  workflowListText,
  workflowText,
} from './read-workflows.reader';
import { readWorkflowsSchema } from './read-workflows.schema';

/**
 * `read_workflows` — the workflow library, read by an ordinary chat (ahead of
 * `propose_workflow`) or by a workflow's builder chat (ahead of
 * `save_workflow_change`).
 */
export class ReadWorkflowsTool extends BaseMcpTool {
  readonly name = HOST_READ_WORKFLOWS_TOOL;
  private readonly logger = new Logger(ReadWorkflowsTool.name);

  constructor(
    private readonly gate: WorkflowProposalBroker,
    private readonly builders: WorkflowBuilderBroker,
    private readonly store: WorkflowStoreService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return (
      this.gate.canPropose(runId, nodeId) ||
      this.builders.canEdit(runId, nodeId)
    );
  }

  protected instructions({ runId, nodeId }: McpListContext): string {
    return readWorkflowsInstructions(this.builders.canEdit(runId, nodeId));
  }

  protected inputSchema(): Record<string, unknown> {
    return readWorkflowsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId } = context;
    const read = readReadWorkflowsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        "Not read: the workflow library is offered to ordinary chats and a workflow's builder chat only.",
        true,
      );
    }
    const { slug } = read.query;
    try {
      return this.text(
        slug === undefined
          ? workflowListText(await this.store.list())
          : workflowText(await this.store.get(slug)),
      );
    } catch (error) {
      if (error instanceof BaseException) {
        // A YAML parse error quotes the file's lines around the fault, a
        // profile path among them: the first line names the fault alone.
        return this.text(
          `${error.errorCode}: ${firstLineOf(error.message)}`,
          true,
        );
      }
      // Logged and replaced: a filesystem error names a path under the user's
      // home, and this answer goes to a model whose provider is off the machine.
      this.logger.error(
        `run ${runId} could not read the workflow library: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code = (error as NodeJS.ErrnoException).code;
      return this.text(
        `Not read: the workflow library could not be read${code ? ` (${code})` : ''}.`,
        true,
      );
    }
  }
}
