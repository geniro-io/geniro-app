import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import {
  type AnalysedThreadKind,
  type AnalysisFiled,
  type AnalysisSink,
  type AnalysisTurn,
  type ItemWire,
  MAX_RECOMMENDATIONS_PER_TARGET,
  type RecommendationMarks,
  type RecommendationsPayload,
  type RecommendationsReport,
  type RecommendationsTiming,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { readCard } from '../utils/recommendations-card';
import { analysedThreadKindOf } from '../utils/thread-analysis-guide';
import { ThreadTimelineService } from './thread-timeline.service';

/** Writes one row into the analysis chat's own transcript and answers the row written. */
export type AnalysisRowWriter = (
  kind: ItemKind,
  payload: object,
) => Promise<ItemWire>;

function refused(reason: string): AnalysisFiled {
  return { status: 'refused', reason };
}

/**
 * The checks between an analysis agent and its card: a recommendation must
 * cite rows that exist in the source at or below the snapshot, a plain chat
 * gets no workflow items, ids are unique and say their target — and the
 * timing strip on the card is measured here, never taken from the agent.
 */
@Injectable()
export class AnalysisReportsService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly timelines: ThreadTimelineService,
  ) {}

  sinkFor(turn: AnalysisTurn, write: AnalysisRowWriter): AnalysisSink {
    return {
      turn,
      report: (report) => this.report(turn, report, write),
      mark: (marks) => this.mark(turn, marks, write),
    };
  }

  private async report(
    turn: AnalysisTurn,
    report: RecommendationsReport,
    write: AnalysisRowWriter,
  ): Promise<AnalysisFiled> {
    const em = this.em.fork();
    const source = await this.runDao.getById(turn.sourceRunId, em);
    if (source === null) {
      return refused('SOURCE_GONE — the analysed thread has been deleted');
    }
    const sourceKind = analysedThreadKindOf(source);
    const problem = checkItems(report, sourceKind);
    if (problem !== null) {
      return refused(problem);
    }
    const cited = [
      ...new Set(
        report.items.flatMap((item) => item.evidence.map((ev) => ev.seq)),
      ),
    ];
    const existing = await this.itemDao.existingSeqs(
      turn.sourceRunId,
      cited,
      turn.snapshotSeq,
      em,
    );
    const missing = cited.filter((seq) => !existing.has(seq));
    if (missing.length > 0) {
      return refused(
        `evidence seq ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in the analysed thread (snapshot ends at ${turn.snapshotSeq}) — re-read and cite real rows`,
      );
    }
    const payload: RecommendationsPayload = {
      ...report,
      sourceRunId: turn.sourceRunId,
      sourceKind,
      timing: await this.timing(turn),
    };
    const row = await write('recommendations', payload);
    return { status: 'recorded', seq: row.seq, count: report.items.length };
  }

  private async mark(
    turn: AnalysisTurn,
    marks: RecommendationMarks,
    write: AnalysisRowWriter,
  ): Promise<AnalysisFiled> {
    let card: RecommendationsPayload;
    try {
      card = await readCard(
        this.itemDao,
        turn.analysisRunId,
        marks.cardSeq,
        this.em.fork(),
      );
    } catch {
      return refused(
        `there is no recommendations card at seq ${marks.cardSeq} in this chat`,
      );
    }
    const ids = new Set(card.items.map((item) => item.id));
    const unknown = marks.outcomes
      .map((outcome) => outcome.id)
      .filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      return refused(`the card has no ${unknown.join(', ')}`);
    }
    const row = await write('recommendation_outcome', marks);
    return { status: 'recorded', seq: row.seq, count: marks.outcomes.length };
  }

  private async timing(
    turn: AnalysisTurn,
  ): Promise<RecommendationsTiming | null> {
    const reading = await this.timelines.read(
      turn.sourceRunId,
      turn.snapshotSeq,
      turn.sourceWorking,
    );
    if (reading === null) {
      return null;
    }
    const { timeline } = reading;
    return {
      wallMs: timeline.wallMs,
      activeMs: timeline.activeMs,
      waitingMs: timeline.waitingOnUserMs,
      criticalPathMs: timeline.criticalPathMs,
      sinks: timeline.sinks.map((sink) => ({
        label: sink.nodeId ?? 'agent',
        ms: sink.ms,
      })),
    };
  }
}

/** Why a report's items cannot go on a card as they are, or null. */
export function checkItems(
  report: RecommendationsReport,
  sourceKind: AnalysedThreadKind,
): string | null {
  const seen = new Set<string>();
  for (const item of report.items) {
    if (seen.has(item.id)) {
      return `duplicate id ${item.id}`;
    }
    seen.add(item.id);
    const prefix = item.target === 'workflow' ? 'W-' : 'R-';
    if (!item.id.startsWith(prefix)) {
      return `${item.id} is a ${item.target} item — its id starts with ${prefix}`;
    }
    if (item.target === 'workflow' && sourceKind === 'chat') {
      return `${item.id}: the analysed thread is a plain chat, so only repo recommendations apply`;
    }
  }
  for (const target of ['workflow', 'repo'] as const) {
    const count = report.items.filter((item) => item.target === target).length;
    if (count > MAX_RECOMMENDATIONS_PER_TARGET) {
      return `${count} ${target} items — keep the strongest ${MAX_RECOMMENDATIONS_PER_TARGET} at most`;
    }
  }
  return null;
}
