import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
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
  type RecommendationsTeamStats,
  type RecommendationsTiming,
  type TeamVersionIndexReader,
  type ThreadTimeline,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { analysedProjectIdsOf, analysedSourceOf } from '../utils/analysed-runs';
import { laneOf } from '../utils/analysis-lane';
import { readCard } from '../utils/recommendations-card';
import { teamCardStats } from '../utils/team-runs-fold';
import { analysedThreadKindOf } from '../utils/thread-analysis-guide';
import { ThreadReaderService } from './thread-reader.service';
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
 * cite rows that exist in the run it names (the source, or one of a team
 * analysis's runs) at or below that run's snapshot, a plain chat
 * gets no team items, ids are unique and say their target — and the
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
    private readonly threads: ThreadReaderService,
    private readonly projectScope: ProjectScopeService,
  ) {}

  sinkFor(turn: AnalysisTurn, write: AnalysisRowWriter): AnalysisSink {
    return {
      turn,
      report: (report, versionIndex) =>
        this.report(turn, report, write, versionIndex),
      mark: (marks) => this.mark(turn, marks, write),
    };
  }

  private async report(
    turn: AnalysisTurn,
    report: RecommendationsReport,
    write: AnalysisRowWriter,
    versionIndex: TeamVersionIndexReader | null,
  ): Promise<AnalysisFiled> {
    const em = this.em.fork();
    let sourceKind: AnalysedThreadKind = 'team';
    if (!turn.team) {
      const source = await this.runDao.getById(turn.sourceRunId, em);
      if (source === null) {
        return refused('SOURCE_GONE — the analysed thread has been deleted');
      }
      sourceKind = analysedThreadKindOf(source);
    }
    const problem = checkItems(
      report,
      sourceKind,
      this.memory.enabled,
      report.items.some((item) => item.target === 'project')
        ? await analysedProjectIdsOf(
            turn,
            { runDao: this.runDao, projectScope: this.projectScope },
            em,
          )
        : new Set(),
    );
    if (problem !== null) {
      return refused(problem);
    }
    // Each cited row is checked against the run it names, at that run's own
    // snapshot — a team analysis cites several.
    const cited = new Map<string, { snapshotSeq: number; seqs: Set<number> }>();
    for (const evidence of [
      ...report.items.flatMap((item) => item.evidence),
      ...(report.members ?? []).flatMap((member) => member.evidence),
    ]) {
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
          `evidence seq ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in the analysed ${turn.team ? `run ${runId}` : 'thread'} (snapshot ends at ${snapshotSeq}) — re-read and cite real rows`,
        );
      }
    }
    const teamStats = await this.teamStats(turn, versionIndex);
    const hotspotProblem = checkHotspots(report, teamStats);
    if (hotspotProblem !== null) {
      return refused(hotspotProblem);
    }
    // One run's timing would pass for the team's.
    const reading = turn.team
      ? null
      : await this.timelines.read(
          turn.sourceRunId,
          turn.snapshotSeq,
          turn.sourceWorking,
        );
    const memberProblem = checkMembers(
      report,
      sourceKind,
      teamStats !== null
        ? new Set(teamStats.agents.map((agent) => agent.node))
        : new Set(
            (reading?.fold.lanes ?? []).map((lane) => laneOf(lane.memberId)),
          ),
    );
    if (memberProblem !== null) {
      return refused(memberProblem);
    }
    const payload: RecommendationsPayload = {
      ...report,
      sourceRunId: turn.sourceRunId,
      sourceKind,
      timing: reading === null ? null : timingOf(reading.timeline),
      teamStats,
    };
    const row = await write('recommendations', payload);
    return {
      status: 'recorded',
      seq: row.seq,
      count: report.items.length,
      ...(report.members === undefined
        ? {}
        : { members: report.members.length }),
    };
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

  private async teamStats(
    turn: AnalysisTurn,
    versionIndex: TeamVersionIndexReader | null,
  ): Promise<RecommendationsTeamStats | null> {
    if (!turn.team) {
      return null;
    }
    const folds = await this.threads.foldRuns(turn.team.runs);
    const index =
      versionIndex === null
        ? null
        : await versionIndex(turn.team.slug).catch(() => null);
    return teamCardStats(
      folds.flatMap(({ run, folded }) =>
        run === null || folded === null
          ? []
          : [{ title: run.title, createdAt: run.createdAt, folded }],
      ),
      index,
    );
  }
}

function timingOf(timeline: ThreadTimeline): RecommendationsTiming {
  return {
    wallMs: timeline.wallMs,
    activeMs: timeline.activeMs,
    waitingMs: timeline.waitingOnUserMs,
    criticalPathMs: timeline.criticalPathMs,
    sinks: timeline.sinks.map((sink) => ({
      label: sink.memberId ?? 'agent',
      ms: sink.ms,
    })),
  };
}

/**
 * Why a report's member assessments cannot go on a card, or null: a team
 * thread assesses its members and a plain chat none, each member once and only
 * one that took a turn in the analysed runs, and a verdict other than keep is
 * carried out by team items on the same card and rests on at least one mark,
 * while keep carries none.
 */
export function checkMembers(
  report: RecommendationsReport,
  sourceKind: AnalysedThreadKind,
  /** The members that took a turn in the analysed runs, as the reads name them. */
  members: ReadonlySet<string>,
): string | null {
  const assessed = report.members ?? [];
  if (sourceKind === 'chat') {
    return assessed.length === 0
      ? null
      : 'the analysed thread is a plain chat, so it has no members to assess — leave members out';
  }
  if (assessed.length === 0 && members.size > 0) {
    return 'assess the members: one entry in members for each member of the team that took a turn in the analysed runs';
  }
  const items = new Map(report.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const assessment of assessed) {
    const { member, verdict } = assessment;
    if (seen.has(member)) {
      return `member ${member} is assessed twice — one entry per member`;
    }
    seen.add(member);
    if (!members.has(member)) {
      return `member ${member} took no turn in the analysed runs — assess only members the reads name (${[...members].join(', ')})`;
    }
    const unknown = assessment.items.filter((id) => !items.has(id));
    if (unknown.length > 0) {
      return `member ${member} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the card`;
    }
    const notTeam = assessment.items.filter(
      (id) => items.get(id)?.target !== 'team',
    );
    if (notTeam.length > 0) {
      return `member ${member} names ${notTeam.join(', ')} — only team items (W-…) carry out a member's verdict`;
    }
    if (verdict === 'keep' && assessment.items.length > 0) {
      return `member ${member} is kept, so it names no items — a member with a change to make is tune, reconfigure, replace or remove`;
    }
    if (verdict !== 'keep' && assessment.items.length === 0) {
      return `member ${member}'s verdict ${verdict} names no item — file the team item that carries it out and name it, or keep the member`;
    }
    if (
      verdict !== 'keep' &&
      assessment.usefulness === null &&
      assessment.quality === null
    ) {
      return `member ${member}'s verdict ${verdict} rests on no mark — judge its usefulness or quality, or keep it while the runs give too little to judge`;
    }
  }
  return null;
}

export function checkHotspots(
  report: RecommendationsReport,
  teamStats: RecommendationsTeamStats | null,
): string | null {
  const ids = new Set(report.items.map((item) => item.id));
  const nodes =
    teamStats === null
      ? null
      : new Set(teamStats.agents.map((agent) => agent.node));
  for (const hotspot of report.hotspots) {
    const unknown = hotspot.items.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      return `hotspot "${hotspot.title}" names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the card`;
    }
    if (
      nodes !== null &&
      hotspot.node !== undefined &&
      !nodes.has(hotspot.node)
    ) {
      return `hotspot "${hotspot.title}" names member ${hotspot.node}, which took no turn in the analysed runs — name a member view=runs lists, or leave node out`;
    }
  }
  return null;
}

/** Why a report's items cannot go on a card as they are, or null. */
export function checkItems(
  report: RecommendationsReport,
  sourceKind: AnalysedThreadKind,
  memoryEnabled: boolean,
  /** The projects the analysed runs belong to — a project item must name one. */
  projectIds: ReadonlySet<string>,
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
    if (item.target === 'team' && sourceKind === 'chat') {
      return `${item.id}: the analysed thread is a plain chat, so only repo, user, memory and project recommendations apply`;
    }
    if (item.target === 'project' && projectIds.size === 0) {
      return `${item.id}: the analysed runs belong to no project, so project-instructions recommendations cannot apply`;
    }
    if (item.target === 'project' && !projectIds.has(item.location)) {
      return `${item.id}: location must be the projectId of an analysed run's project (${[...projectIds].join(', ')}) — view=project names it`;
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
