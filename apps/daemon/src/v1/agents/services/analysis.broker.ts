import { Injectable } from '@nestjs/common';

import type {
  AnalysisFiled,
  AnalysisSink,
  AnalysisTurn,
  RecommendationMarks,
  RecommendationsReport,
  TeamVersionIndexReader,
} from '../chat.types';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * The rendezvous behind the analysis tools (`read_analyzed_thread` and its
 * siblings) — mechanics in {@link HostSinkBroker}. A chat holds a sink only
 * while one of its turns runs AND it is an analysis (`analysisTurnOf`), which
 * is what keeps the tools off every other chat's listing and scopes them to
 * what the analysis was started on — one source, or a team's runs.
 */
@Injectable()
export class AnalysisBroker extends HostSinkBroker<AnalysisSink> {
  /** Whether this member is an analysis turn right now — gates the tool listing. */
  canAnalyse(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  turnOf(
    runId: string,
    memberId: string,
  ): Promise<AnalysisTurn | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no analysis turn is running',
      'read the analysed thread',
      (sink) => Promise.resolve(sink.turn),
    );
  }

  report(
    runId: string,
    memberId: string,
    report: RecommendationsReport,
    versionIndex: TeamVersionIndexReader | null = null,
  ): Promise<AnalysisFiled | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no analysis turn is running that could record them',
      'record recommendations',
      (sink) => sink.report(report, versionIndex),
    );
  }

  mark(
    runId: string,
    memberId: string,
    marks: RecommendationMarks,
  ): Promise<AnalysisFiled | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no analysis turn is running that could record them',
      'record recommendation outcomes',
      (sink) => sink.mark(marks),
    );
  }
}
