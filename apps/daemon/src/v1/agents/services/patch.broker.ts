import { Injectable } from '@nestjs/common';

import type { HostPatch, HostPatchOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Puts a proposed patch to the user and resolves with what they decided.
 *
 * A rendezvous and nothing more — the mechanics live in {@link HostSinkBroker}.
 * What is this tool's own: it PARKS, like the question broker and unlike the
 * two drawing tools. The returned promise is held open by a live turn until the
 * user presses Apply or Reject on the card, which is why an entry outliving its
 * turn would be answered into nothing.
 */
export type PatchProposer = (
  patch: HostPatch,
  signal?: AbortSignal,
) => Promise<HostPatchOutcome>;

@Injectable()
export class PatchBroker extends HostSinkBroker<PatchProposer> {
  /** Whether this member can currently propose — gates the tool listing. */
  canPropose(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  /**
   * Whether the listing for this member says the call returns at once — set by
   * `register`'s `answersAtOnce`, and gone with the sink.
   */
  answersAtOnce(runId: string, memberId: string): boolean {
    return this.sinkAnswersAtOnce(runId, memberId);
  }

  /**
   * Put the patch to the user and resolve with the verdict. Never throws.
   *
   * `signal` is the CALLER abandoning its own call — `UserQuestionBroker.ask`
   * carries the same argument for the same reason: every parking host tool
   * leaves a live card behind when the agent stops waiting for it.
   */
  async propose(
    runId: string,
    memberId: string,
    patch: HostPatch,
    signal?: AbortSignal,
  ): Promise<HostPatchOutcome> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could put it on screen',
      'propose a patch',
      (proposer) => proposer(patch, signal),
    );
  }
}
