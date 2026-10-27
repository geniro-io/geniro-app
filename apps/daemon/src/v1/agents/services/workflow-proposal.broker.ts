import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/**
 * One ordinary chat turn's standing to read the workflow library and propose a
 * workflow. It carries nothing to call: the card is raised by
 * `WorkflowProposalService` (`v1/graphs`) through `ChatService`, and it
 * outlives the turn — what the sink decides is only who is offered the tools.
 */
export interface WorkflowProposalSink {
  runId: string;
}

/**
 * Gates `read_workflows` and `propose_workflow` to ordinary chats: never a
 * workflow node, a workflow's own builder chat or an analysis. An analysis
 * changes a workflow through `save_workflow_change`; a builder chat reads the
 * library and proposes changes to its own workflow through the same tools,
 * gated by `WorkflowBuilderBroker` instead.
 */
@Injectable()
export class WorkflowProposalBroker extends HostSinkBroker<WorkflowProposalSink> {
  canPropose(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }
}
