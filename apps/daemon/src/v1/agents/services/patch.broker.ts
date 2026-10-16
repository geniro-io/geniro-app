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
  /**
   * Nodes whose listing must say the call returns at once.
   *
   * Set beside {@link register} for a CLI that will not hold the call open,
   * and dropped once that node's sink is gone, so a later blocking turn of
   * the same run is described as blocking again.
   */
  private readonly deferredListings = new Set<string>();

  /** Whether this node can currently propose — gates the tool listing. */
  canPropose(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Remember how this node's tool listing should describe the wait. */
  noteDeferred(runId: string, nodeId: string, deferred: boolean): void {
    const key = `${runId}::${nodeId}`;
    if (deferred) {
      this.deferredListings.add(key);
    } else {
      this.deferredListings.delete(key);
    }
  }

  /** Whether the listing for this node says the call returns at once. */
  answersAtOnce(runId: string, nodeId: string): boolean {
    return this.deferredListings.has(`${runId}::${nodeId}`);
  }

  /** Drop the listing flag once the sink that owned it is gone. */
  clearDeferredIfIdle(runId: string, nodeId: string): void {
    if (!this.canPropose(runId, nodeId)) {
      this.deferredListings.delete(`${runId}::${nodeId}`);
    }
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
    nodeId: string,
    patch: HostPatch,
    signal?: AbortSignal,
  ): Promise<HostPatchOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could put it on screen',
      'propose a patch',
      (proposer) => proposer(patch, signal),
    );
  }
}
