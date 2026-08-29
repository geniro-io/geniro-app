import { Injectable } from '@nestjs/common';

import type { HostComparison, HostComparisonOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Draws a host-rendered comparison (`HOST_COMPARISON_TOOL`) into the run's own
 * transcript.
 *
 * A rendezvous and nothing more — the mechanics live in {@link HostSinkBroker}.
 * Fire-and-forget like the chart and the scorecard: the agent is not waiting on
 * a person, only on the row being durable.
 */
export type ComparisonDrawer = (
  comparison: HostComparison,
) => Promise<HostComparisonOutcome>;

@Injectable()
export class ComparisonBroker extends HostSinkBroker<ComparisonDrawer> {
  /** Whether this node can currently draw — gates the tool listing. */
  canDraw(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Draw the comparison and resolve with what happened. Never throws. */
  async draw(
    runId: string,
    nodeId: string,
    comparison: HostComparison,
  ): Promise<HostComparisonOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could draw it',
      'draw a comparison',
      (drawer) => drawer(comparison),
    );
  }
}
