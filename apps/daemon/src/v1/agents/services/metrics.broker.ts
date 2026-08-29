import { Injectable } from '@nestjs/common';

import type { HostMetrics, HostMetricsOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Draws a host-rendered scorecard (`HOST_METRICS_TOOL`) into the run's own
 * transcript.
 *
 * A rendezvous and nothing more — the mechanics live in {@link HostSinkBroker}.
 * Fire-and-forget like the chart and the findings report: the agent is not
 * waiting on a person, only on the row being durable.
 */
export type MetricsDrawer = (
  metrics: HostMetrics,
) => Promise<HostMetricsOutcome>;

@Injectable()
export class MetricsBroker extends HostSinkBroker<MetricsDrawer> {
  /** Whether this node can currently draw — gates the tool listing. */
  canDraw(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Draw the scorecard and resolve with what happened. Never throws. */
  async draw(
    runId: string,
    nodeId: string,
    metrics: HostMetrics,
  ): Promise<HostMetricsOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could draw it',
      'draw a scorecard',
      (drawer) => drawer(metrics),
    );
  }
}
