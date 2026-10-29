import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { MemoryService } from '../../memory/services/memory.service';
import type { ItemKind } from '../../runs/runs.types';
import {
  type AnalysedThreadKind,
  type AnalysisFiled,
  type AnalysisSink,
  type AnalysisTurn,
  type ItemWire,
  MAX_RECOMMENDATIONS_PER_TARGET,
  RECOMMENDATION_ID_PREFIX,
  RECOMMENDATION_TARGETS,
  type RecommendationMarks,
  type RecommendationsPayload,
  type RecommendationsReport,
  type RecommendationsTiming,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { analysedSourceOf } from '../utils/analysed-runs';
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
 * cite rows that exist in the run it names (the source, or one of a workflow
 * analysis's runs) at or below that run's snapshot, a plain chat
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
    private readonly memory: MemoryService,
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
    let sourceKind: AnalysedThreadKind = 'workflow';
    if (!turn.workflow) {
      const source = await this.runDao.getById(turn.sourceRunId, em);
      if (source === null) {
        return refused('SOURCE_GONE — the analysed thread has been deleted');
      }
      sourceKind = analysedThreadKindOf(source);
    }
    const problem = checkItems(report, sourceKind, this.memory.enabled);
    if (problem !== null) {
      return refused(problem);
    }
    // Each cited row is checked against the run it names, at that run's own
    // snapshot — a workflow analysis cites several.
    const cited = new Map<string, { snapshotSeq: number; seqs: Set<number> }>();
    for (const evidence of report.items.flatMap((item) => item.evidence)) {
      const source = analysedSourceOf(turn, evidence.runId);
      if ('error' in source) {
        return refused(
          `evidence runId ${evidence.runId} is not one of the runs this analysis reads — view=runs lists them`,
        );
      }
      const entry = cited.get(source.sourceRunId) ?? {
        snapshotSeq: source.snapshotSeq,
        seqs: new Set<number>(),
      };
      entry.seqs.add(evidence.seq);
      cited.set(source.sourceRunId, entry);
    }
    for (const [runId, { snapshotSeq, seqs }] of cited) {
      const wanted = [...seqs];
      const existing = await this.itemDao.existingSeqs(
        runId,
        wanted,
        snapshotSeq,
        em,
      );
      const missing = wanted.filter((seq) => !existing.has(seq));
      if (missing.length > 0) {
        return refused(
          `evidence seq ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in the analysed ${turn.workflow ? `run ${runId}` : 'thread'} (snapshot ends at ${snapshotSeq}) — re-read and cite real rows`,
        );
      }
    }
    const payload: RecommendationsPayload = {
      ...report,
      sourceRunId: turn.sourceRunId,
      sourceKind,
      // One run's timing would pass for the workflow's; the comparison is the
      // analysis's own to state.
      timing: turn.workflow ? null : await this.timing(turn),
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
  memoryEnabled: boolean,
): string | null {
  const seen = new Set<string>();
  for (const item of report.items) {
    if (seen.has(item.id)) {
      return `duplicate id ${item.id}`;
    }
    seen.add(item.id);
    const prefix = RECOMMENDATION_ID_PREFIX[item.target];
    if (!item.id.startsWith(prefix)) {
      return `${item.id} is a ${item.target} item — its id starts with ${prefix}`;
    }
    if (item.target === 'memory' && !memoryEnabled) {
      return `${item.id}: the shared memory is off, so memory recommendations cannot apply`;
    }
    if (item.target === 'workflow' && sourceKind === 'chat') {
      return `${item.id}: the analysed thread is a plain chat, so only repo, user and memory recommendations apply`;
    }
  }
  for (const target of RECOMMENDATION_TARGETS) {
    const count = report.items.filter((item) => item.target === target).length;
    if (count > MAX_RECOMMENDATIONS_PER_TARGET) {
      return `${count} ${target} items — keep the strongest ${MAX_RECOMMENDATIONS_PER_TARGET} at most`;
    }
  }
  return null;
}
