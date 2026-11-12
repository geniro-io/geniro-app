import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/** A team member's standing to write its run's goals; it carries nothing to call. */
export interface GoalWriterSink {
  runId: string;
}

/**
 * A gate only: who in a team run writes its goals. The team executor registers
 * every member, and only the lead's sink is offered, in its own conversation
 * while its own turn runs. A chat registers nothing — its agent writes its
 * goals as before, which `GoalsTool` tells apart by the run.
 */
@Injectable()
export class GoalWritersBroker extends HostSinkBroker<GoalWriterSink> {
  isTeamMember(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  canWrite(
    runId: string,
    memberId: string,
    conversationId: string | null,
  ): boolean {
    return this.offers(runId, memberId, conversationId);
  }
}
