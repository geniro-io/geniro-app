import { HOST_PROPOSE_WORKFLOW_TOOL } from '../../../agents/chat.types';
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
} from './propose-workflow.reader';
import { proposeWorkflowSchema } from './propose-workflow.schema';

/**
 * `propose_workflow` — a whole workflow on a card the user approves. It does
 * NOT wait for the answer: the card outlives the turn and the verdict arrives
 * as the run's next message (`WorkflowProposalService`), so no CLI's tool-call
 * deadline can expire it.
 */
export class ProposeWorkflowTool extends BaseMcpTool {
  readonly name = HOST_PROPOSE_WORKFLOW_TOOL;

  constructor(
    private readonly gate: WorkflowProposalBroker,
    private readonly proposals: WorkflowProposalService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.gate.canPropose(runId, nodeId);
  }

  protected instructions(): string {
    return proposeWorkflowInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return proposeWorkflowSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readProposeWorkflowArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.gate.canPropose(runId, nodeId)) {
      return this.text(
        'Not proposed: workflows are proposed from ordinary chats only.',
        true,
      );
    }
    const outcome = await this.proposals.propose(runId, read.query);
    return this.text(
      proposeWorkflowResultText(outcome),
      outcome.status === 'refused',
    );
  }
}
