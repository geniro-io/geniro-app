import { Injectable, Logger } from '@nestjs/common';

import type { HostFindingsOutcome, HostFindingsReport } from '../chat.types';

/**
 * Files a host-rendered findings report (`HOST_FINDINGS_TOOL`) into the run's
 * own transcript.
 *
 * A RENDEZVOUS and nothing more, exactly as {@link UserQuestionBroker} is: the
 * MCP endpoint knows how to receive the call, the turn that owns the run knows
 * how to allocate a seq and persist an item, and the two are in different
 * modules. Whoever runs the turn registers a reporter for its length; the tool
 * looks one up. Nothing here writes a row or touches the event bus — doing that
 * would be a second producer of the same item, free to disagree with the one
 * seam every other transcript row goes through.
 *
 * In memory and per LAUNCH, for the reason the question broker is: a reporter
 * closes over a live turn's seq allocator, so an entry outliving that turn
 * would file rows against a conversation nothing is watching.
 */
export type FindingsReporter = (
  report: HostFindingsReport,
) => Promise<HostFindingsOutcome>;

@Injectable()
export class FindingsReportBroker {
  private readonly logger = new Logger(FindingsReportBroker.name);
  private readonly reporters = new Map<string, FindingsReporter>();

  private key(runId: string, nodeId: string): string {
    return `${runId}::${nodeId}`;
  }

  /**
   * Install the reporter for one node's turn; the returned disposer removes it.
   *
   * A disposer rather than a keyed `unregister(runId, nodeId)`, on the question
   * broker's reasoning: settle paths run late and out of order, so a keyed
   * removal would silently tear down the reporter a LATER turn of the same run
   * had already installed.
   */
  register(
    runId: string,
    nodeId: string,
    reporter: FindingsReporter,
  ): () => void {
    const key = this.key(runId, nodeId);
    this.reporters.set(key, reporter);
    return () => {
      if (this.reporters.get(key) === reporter) {
        this.reporters.delete(key);
      }
    };
  }

  /**
   * Whether this node can currently file a report — what gates the tool
   * listing, so an agent is never offered a tool whose output nobody would see.
   */
  canReport(runId: string, nodeId: string): boolean {
    return this.reporters.has(this.key(runId, nodeId));
  }

  /**
   * File the report and resolve with what happened.
   *
   * Never throws: a report that cannot be filed is an OUTCOME the agent reads
   * and carries on from — it still has the findings and can write them in its
   * reply — where a throw would cross the MCP transport as a tool error and
   * read to the model as its own call being malformed.
   */
  async report(
    runId: string,
    nodeId: string,
    report: HostFindingsReport,
  ): Promise<HostFindingsOutcome> {
    const reporter = this.reporters.get(this.key(runId, nodeId));
    if (!reporter) {
      return {
        status: 'unavailable',
        reason: 'no turn is running that could record them',
      };
    }
    try {
      return await reporter(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `run ${runId}/${nodeId} could not record findings: ${message}`,
      );
      return { status: 'unavailable', reason: message };
    }
  }
}
