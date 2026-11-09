import { Injectable } from '@nestjs/common';

import type {
  HostProjectInstructions,
  HostProjectInstructionsOutcome,
} from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/** Puts a chat's change to a project's instructions on a card and resolves with the user's answer. */
export type ProjectInstructionsProposer = (
  change: HostProjectInstructions,
  signal?: AbortSignal,
) => Promise<HostProjectInstructionsOutcome>;

/** The rendezvous behind `save_project_instructions`' card; it parks like {@link PatchBroker}. */
@Injectable()
export class ProjectInstructionsBroker extends HostSinkBroker<ProjectInstructionsProposer> {
  canPropose(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  answersAtOnce(runId: string, memberId: string): boolean {
    return this.sinkAnswersAtOnce(runId, memberId);
  }

  async propose(
    runId: string,
    memberId: string,
    change: HostProjectInstructions,
    signal?: AbortSignal,
  ): Promise<HostProjectInstructionsOutcome> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could put it on screen',
      'propose a change to project instructions',
      (proposer) => proposer(change, signal),
    );
  }
}
