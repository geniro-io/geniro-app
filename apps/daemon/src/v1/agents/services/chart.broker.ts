import { Injectable } from '@nestjs/common';

import type { HostChart, HostChartOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Draws a host-rendered chart (`HOST_CHART_TOOL`) into the run's own transcript.
 *
 * A rendezvous and nothing more — the mechanics, and why they are what they
 * are, live in {@link HostSinkBroker}. Fire-and-forget like the findings
 * report, and for the same reason: the agent is not waiting on a person, only
 * on the row being durable.
 */
export type ChartDrawer = (chart: HostChart) => Promise<HostChartOutcome>;

@Injectable()
export class ChartBroker extends HostSinkBroker<ChartDrawer> {
  /** Whether this node can currently draw — gates the tool listing. */
  canDraw(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Draw the chart and resolve with what happened. Never throws. */
  async draw(
    runId: string,
    nodeId: string,
    chart: HostChart,
  ): Promise<HostChartOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could draw it',
      'draw a chart',
      (drawer) => drawer(chart),
    );
  }
}
