import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/**
 * One chat turn's standing to read the team library and propose a team. It
 * carries nothing to call: the card is raised by `TeamProposalService`
 * (`v1/teams`) through `ChatService`, and it outlives the turn — what the sink
 * decides is only who is offered the tools.
 */
export interface TeamProposalSink {
  runId: string;
}

/**
 * Gates `read_teams` and `propose_team` to chats, whichever kind — ordinary, a
 * team's builder, a project's own or an analysis — and never a team member.
 * `TeamBuilderBroker` and `ProjectChatBroker` only say what a call naming no
 * target means there.
 */
@Injectable()
export class TeamProposalBroker extends HostSinkBroker<TeamProposalSink> {
  canPropose(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }
}
