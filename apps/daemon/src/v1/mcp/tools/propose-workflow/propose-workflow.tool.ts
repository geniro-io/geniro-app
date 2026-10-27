import { HOST_PROPOSE_WORKFLOW_TOOL } from '../../../agents/chat.types';
import type { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
import type { WorkflowProposalBroker } from '../../../agents/services/workflow-proposal.broker';
import type { WorkflowProposalService } from '../../../graphs/services/workflow-proposal.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposeWorkflowInstructions } from './propose-workflow.instructions';
import {
  proposeWorkflowResultText,
  readProposeWorkflowArgs,
  readProposeWorkflowChangeArgs,
} from './propose-workflow.reader';
import { proposeWorkflowSchema } from './propose-workflow.schema';

/**
 * `propose_workflow` — a workflow on a card the user approves: a whole one
 * from an ordinary chat, or edits to its own from a workflow's builder chat.
 * It does NOT wait for the answer: the card outlives the turn and the verdict
 * arrives as the run's next message (`WorkflowProposalService`), so no CLI's
 * tool-call deadline can expire it.
 */
export class ProposeWorkflowTool extends BaseMcpTool {
  readonly name = HOST_PROPOSE_WORKFLOW_TOOL;

  constructor(
    private readonly gate: WorkflowProposalBroker,
    private readonly builders: WorkflowBuilderBroker,
    private readonly proposals: WorkflowProposalService,
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
    return proposeWorkflowInstructions(this.builders.canEdit(runId, nodeId));
  }

  protected inputSchema({
    runId,
    nodeId,
  }: McpListContext): Record<string, unknown> {
    return proposeWorkflowSchema(this.builders.canEdit(runId, nodeId));
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    // A call is not checked against the listing, so the gate is asked again.
    if (this.builders.canEdit(runId, nodeId)) {
      return this.proposeChange(args, runId, nodeId);
    }
    const read = readProposeWorkflowArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    if (!this.gate.canPropose(runId, nodeId)) {
      return this.text(
        "Not proposed: workflows are proposed from ordinary chats and a workflow's own builder chat only.",
        true,
      );
    }
    const outcome = await this.proposals.propose(runId, read.query);
    return this.text(
      proposeWorkflowResultText(outcome),
      outcome.status === 'refused',
    );
  }

  private async proposeChange(
    args: Record<string, unknown>,
    runId: string,
    nodeId: string,
  ): Promise<McpToolResult> {
    const read = readProposeWorkflowChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.builders.workflowOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Not proposed: ${turn.reason}.`, true);
    }
    const outcome = await this.proposals.proposeChange(runId, {
      ...read.query,
      slug: turn.slug,
    });
    return this.text(
      proposeWorkflowResultText(outcome),
      outcome.status === 'refused',
    );
  }
}
