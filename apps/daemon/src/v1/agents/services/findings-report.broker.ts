import { Injectable } from '@nestjs/common';

import type { HostFindingsOutcome, HostFindingsReport } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Files a host-rendered findings report (`HOST_FINDINGS_TOOL`) into the run's
 * own transcript.
 *
 * A rendezvous and nothing more — the mechanics, and why they are what they
 * are, live in {@link HostSinkBroker}. What is this tool's own: a report is
 * FIRE-AND-FORGET, unlike a question. Nothing is parked, because the agent is
 * not waiting on a person, only on the row being durable.
 */
export type FindingsReporter = (
  report: HostFindingsReport,
) => Promise<HostFindingsOutcome>;

@Injectable()
export class FindingsReportBroker extends HostSinkBroker<FindingsReporter> {
  /** Whether this node can currently file a report — gates the tool listing. */
  canReport(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** File the report and resolve with what happened. Never throws. */
  async report(
    runId: string,
    nodeId: string,
    report: HostFindingsReport,
  ): Promise<HostFindingsOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could record them',
      'record findings',
      (reporter) => reporter(report),
    );
  }
}
