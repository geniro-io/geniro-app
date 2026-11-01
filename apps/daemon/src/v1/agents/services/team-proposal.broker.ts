import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/**
 * One ordinary chat turn's standing to read the team library and propose a
 * team. It carries nothing to call: the card is raised by
 * `TeamProposalService` (`v1/teams`) through `ChatService`, and it
 * outlives the turn — what the sink decides is only who is offered the tools.
 */
export interface TeamProposalSink {
  runId: string;
}

/**
 * Gates `read_teams` and `propose_team` to ordinary chats: never a
 * team node, a team's own builder chat or an analysis. An analysis
 * changes a team through `save_team_change`; a builder chat reads the
 * library and proposes changes to its own team through the same tools,
 * gated by `TeamBuilderBroker` instead.
 */
@Injectable()
export class TeamProposalBroker extends HostSinkBroker<TeamProposalSink> {
  canPropose(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }
}
