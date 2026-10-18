import { Injectable, Logger } from '@nestjs/common';

import type { ThreadOverviewPart, ThreadOverviewWire } from '../chat.types';
import { ChatArtifactsService } from './chat-artifacts.service';
import { ChatMetricsService } from './chat-metrics.service';
import { ChatTimelineService } from './chat-timeline.service';
import { RunStateService } from './run-state.service';
import { ThreadAnalysisService } from './thread-analysis.service';

/**
 * Several of a thread's opening reads in one answer — see
 * `ThreadOverviewWireSchema` for why.
 *
 * Composes only: each part is the very call its own route makes, so a part
 * read here and the same part read alone can never disagree. The parts are
 * asked at once; the slowest decides when the answer lands.
 */
@Injectable()
export class ThreadOverviewService {
  private readonly logger = new Logger(ThreadOverviewService.name);

  constructor(
    private readonly runState: RunStateService,
    private readonly metrics: ChatMetricsService,
    private readonly timeline: ChatTimelineService,
    private readonly artifacts: ChatArtifactsService,
    private readonly analyses: ThreadAnalysisService,
  ) {}

  /**
   * The parts asked for, `null` for the rest and for one that alone could not
   * be read. When NO part asked for could be read, the first reason is thrown
   * instead — a thread that does not exist is the route's 404, exactly as it
   * is each part's own.
   */
  async read(
    runId: string,
    parts: readonly ThreadOverviewPart[],
  ): Promise<ThreadOverviewWire> {
    const asked = new Set(parts);
    const readers: {
      [K in ThreadOverviewPart]: () => Promise<
        NonNullable<ThreadOverviewWire[K]>
      >;
    } = {
      state: () => this.runState.read(runId),
      totals: () => this.metrics.readTotalsResponse(runId),
      timeline: () => this.timeline.read(runId),
      artifacts: () => this.artifacts.read(runId),
      analysis: async () => ({ analysis: await this.analyses.find(runId) }),
    };
    const order = [...asked];
    const settled = await Promise.allSettled(
      order.map((part) => readers[part]()),
    );
    const failed = settled.flatMap((result, index) =>
      result.status === 'rejected' ? [{ part: order[index]!, result }] : [],
    );
    if (failed.length === settled.length) {
      throw failed[0]!.result.reason;
    }
    for (const { part, result } of failed) {
      this.logger.warn(
        `run ${runId}: the ${part} part of the overview could not be read: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
    const answer: ThreadOverviewWire = {
      state: null,
      totals: null,
      timeline: null,
      artifacts: null,
      analysis: null,
    };
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        Object.assign(answer, { [order[index]!]: result.value });
      }
    });
    return answer;
  }
}
