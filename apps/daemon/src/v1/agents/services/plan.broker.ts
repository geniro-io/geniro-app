import { Injectable } from '@nestjs/common';

import type { HostPlan, HostPlanOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Puts a proposed plan to the user and resolves with what they decided.
 *
 * A rendezvous and nothing more — the mechanics live in {@link HostSinkBroker}.
 * PARKS like the question and patch brokers and unlike the two drawing tools:
 * the returned promise is held open by a live turn until the user answers the
 * card, which is why an entry outliving its turn would be answered into nothing.
 */
export type PlanProposer = (
  plan: HostPlan,
  signal?: AbortSignal,
) => Promise<HostPlanOutcome>;

@Injectable()
export class PlanBroker extends HostSinkBroker<PlanProposer> {
  /** Whether this node can currently propose — gates the tool listing. */
  canPropose(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /**
   * Put the plan to the user and resolve with the verdict. Never throws.
   *
   * `signal` is the CALLER abandoning its own call — `UserQuestionBroker.ask`
   * carries the same argument for the same reason: every parking host tool
   * leaves a live card behind when the agent stops waiting for it.
   */
  async propose(
    runId: string,
    nodeId: string,
    plan: HostPlan,
    signal?: AbortSignal,
  ): Promise<HostPlanOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could put it on screen',
      'propose a plan',
      (proposer) => proposer(plan, signal),
    );
  }
}
