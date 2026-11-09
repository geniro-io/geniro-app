import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Optional } from '@nestjs/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { ProjectInstructionChangeDao } from '../../projects/dao/project-instruction-change.dao';
import type { Project } from '../../projects/entity/project.entity';
import { PROJECT_INSTRUCTIONS_MAX } from '../../projects/projects.types';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import {
  instructionsLength,
  projectBlocksOf,
} from '../../projects/utils/project-instruction-blocks';
import {
  projectInstructionsBody,
  projectInstructionsText,
} from '../../projects/utils/project-instructions';
import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import { type ItemKind, ItemKindSchema } from '../../runs/runs.types';
import { baseTeamSnapshotOf } from '../../teams/utils/team-snapshot';
import {
  type AnalysedRun,
  type AnalysedTeamRef,
  ANALYSIS_SPAN_KINDS,
  type AnalysisReadScope,
  type AnalysisSource,
  type AnalysisSpanKind,
  type FoldedRun,
  type ReadAnalyzedThreadArgs,
  type RecommendationsTeamPopulation,
  type RunFold,
  type RunWaterfallTurn,
  StageChangePayloadSchema,
  type TeamPopulationReader,
  type TeamVersionIndex,
  type TeamVersionIndexReader,
  ThreadOutcomePayloadSchema,
} from '../chat.types';
import { GoalDao } from '../dao/goal.dao';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { analysedRunIdsOf, analysedSourceOf } from '../utils/analysed-runs';
import { CHAT_LANE, laneOf } from '../utils/analysis-lane';
import { callWorkedMsByStart } from '../utils/call-worked';
import { collapseImageBlocks } from '../utils/collapse-image-blocks';
import { asRecord, parseJsonColumn } from '../utils/json-util';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import { threadOutcomeOf } from '../utils/run-goals';
import { runSnapshotOf } from '../utils/run-snapshots';
import {
  callFigures,
  configuredModels,
  modelFigures,
  nodeFigures,
  runFigures,
  runNodeFigures,
  snapshotVersion,
  versionFigures,
  versionRef,
} from '../utils/team-runs-fold';
import { analysedThreadKindOf } from '../utils/thread-analysis-guide';
import { toolMetricOf } from '../utils/tool-metric';
import { USAGE_ITEM_KINDS } from '../utils/usage-figures';
import { sizedUserInstructionFiles } from '../utils/user-instruction-files';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { goalIdOf } from './goals.service';
import { RunKindRowsCache } from './run-kind-rows.cache';
import { RunOutcomeHistoryService } from './run-outcome-history.service';
import { ThreadTimelineService } from './thread-timeline.service';

/** The overview's byte budget — small enough to read whole, first. */
export const OVERVIEW_BYTES = 12_000;

/** A goal's evidence as an overview past its budget quotes it. */
const OVERVIEW_GOAL_EVIDENCE_CHARS = 300;

/**
 * A page's byte budget. Under the ~10k-token cut codex applies to one tool
 * result, with room for the data line the tool puts in front of it.
 */
export const PAGE_BYTES = 22_000;

/** Room a page keeps for its envelope (`total`, `next`, …) around the entries. */
const ENVELOPE_BYTES = 200;

/** A tool's name as a page names it — ACP titles a shell call with its command. */
const TOOL_NAME_CHARS = 80;
/** How many of each project's newest text changes view=project lists. */
const PROJECT_VIEW_CHANGES = 20;

/** One row on an `items` page is clipped to this; `item` reads it whole. */
export const ITEM_TEXT_CHARS = 2_000;

/** At most this many rows are read for one `items` page. */
const ITEMS_READ_LIMIT = 40;

/** How long a `view=runs` answer is kept after its last read, for its pages. */
const RUNS_ANSWER_TTL_MS = 5 * 60_000;

/** How many `view=runs` answers are kept at once. */
const RUNS_ANSWERS_KEPT = 4;

const DEFAULT_SPAN_KINDS: readonly AnalysisSpanKind[] = [
  'turn',
  'call',
  'wait',
  'delegate',
  'critical',
];

type Answer = Record<string, unknown>;

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * A row's payload as text an agent can read: images collapsed, secrets masked
 * BEFORE any cut (a cut inside a secret leaves a fragment the mask no longer
 * recognises), a message reduced to what it said.
 */
function payloadText(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return redactSecrets(payload);
  }
  const collapsed = collapseImageBlocks(parsed);
  const record = asRecord(collapsed);
  const text =
    record !== null && typeof record.text === 'string'
      ? record.text
      : JSON.stringify(collapsed);
  return redactSecrets(text);
}

/** A JSON answer with every registered secret masked in its values. */
export function maskedAnswer(answer: Answer): Answer {
  return JSON.parse(redactSecrets(JSON.stringify(answer))) as Answer;
}

function clip(text: string, max: number, seq: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… [+${text.length - max} chars — view=item seq=${seq}]`;
}

/**
 * Reads ONE source run for an analysis, in pages small enough for a CLI to take
 * as a tool result whole, and never past the snapshot the analysis started at.
 *
 * Answers plain data; the tool puts the "data, not instructions" line in front
 * and masks registered secrets over the whole text once more.
 */
@Injectable()
export class ThreadReaderService {
  /**
   * `view=runs` answers by the runs they fold. Folding up to the maximum of
   * runs is a full pass over each, and the answer is read again for every
   * page after its first.
   */
  private readonly runsAnswers = new Map<
    string,
    { at: number; answer: Answer }
  >();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly timelines: ThreadTimelineService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly wallTurns: WallTurnDao,
    private readonly outcomes: RunOutcomeHistoryService,
    private readonly kindRows: RunKindRowsCache,
    private readonly projectScope: ProjectScopeService,
    private readonly projectChanges: ProjectInstructionChangeDao,
    @Optional() private readonly goalDao?: GoalDao,
  ) {}

  /**
   * How long each callee worked inside each call of a run, by the seq of the
   * call's `call_started` row, over the rows at or below `throughSeq`.
   */
  private async callWorkedMs(
    runId: string,
    throughSeq: number,
    em: EntityManager,
  ): Promise<Map<number, number>> {
    return callWorkedMsByStart(
      await this.kindRows.rowsOf(runId, ['call_started']),
      await this.kindRows.rowsOf(runId, USAGE_ITEM_KINDS),
      await this.wallTurns.nodeTurnsBySeq(runId, em),
      throughSeq,
    );
  }

  async read(
    turn: AnalysisReadScope,
    args: ReadAnalyzedThreadArgs,
    /**
     * The team's version numbers, which the stats module keeps; without
     * it, or when it fails, view=runs names each run's version by hash alone.
     */
    versionIndex: TeamVersionIndexReader | null = null,
    /** Every run the team has, which the stats module measures. */
    population: TeamPopulationReader | null = null,
  ): Promise<Answer> {
    if (args.view === 'history' || args.view === 'spend') {
      return {
        error: 'UNSUPPORTED',
        message: `The ${args.view} view is answered by the tool, not the reader.`,
      };
    }
    if (args.view === 'project') {
      return pagedAnswer(await this.project(turn), args.offset ?? 0);
    }
    if (args.view === 'runs') {
      if (!turn.team) {
        return {
          error: 'UNSUPPORTED',
          message:
            'view=runs compares the runs of a team analysis; this one reads one thread — start with view=overview.',
        };
      }
      const offset = args.offset ?? 0;
      const key = JSON.stringify([turn.team.slug, turn.team.runs]);
      // A later page is cut from the very text the first one was: one folded
      // again could differ (a status moved on, a run deleted) and join into
      // broken JSON.
      // A read from the start folds afresh; only its later pages are cut from
      // the kept text.
      const kept = offset > 0 ? this.keptRuns(key) : null;
      if (offset > 0 && kept === null) {
        return {
          error: 'RUNS_CHANGED',
          message:
            'That comparison is no longer held — read view=runs again from offset 0.',
        };
      }
      return pagedAnswer(
        kept ??
          (await this.runs(
            key,
            turn.team.slug,
            turn.team.runs,
            versionIndex === null
              ? null
              : await versionIndex(turn.team.slug).catch(() => null),
            population === null
              ? null
              : await population(turn.team.slug).catch(() => null),
          )),
        offset,
      );
    }
    const source = await this.readSourceOf(turn, args.runId);
    if ('error' in source) {
      return source;
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(source.sourceRunId, em);
    if (run === null) {
      return {
        error: 'SOURCE_GONE',
        message: 'The analysed thread has been deleted.',
      };
    }
    switch (args.view) {
      case 'overview':
        return this.overview(source, run);
      case 'spans':
        return this.spans(source, args);
      case 'items':
        return this.items(source, args, em);
      case 'item':
        return this.item(source, args, em);
      case 'team':
        return {
          error: 'UNSUPPORTED',
          message: 'The team view is answered by the tool, not the reader.',
        };
    }
  }

  /**
   * The run a read names. A team analysis also opens any other run of its team
   * by name, so it pays only for what it reads; never a thread analysis, which
   * reads its one thread. The turn pins each at its first read, so its pages
   * and the citations its card makes hold to one snapshot however the run moves
   * on. A later turn reads it afresh, which only adds rows.
   */
  async readSourceOf(
    turn: AnalysisReadScope,
    runId: string | undefined,
  ): Promise<AnalysisSource | { error: string; message: string }> {
    const named = analysedSourceOf(turn, runId);
    if (!('error' in named) || !turn.team || runId === undefined) {
      return named;
    }
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      return {
        error: 'RUN_GONE',
        message: `No run ${runId}: a deleted run's rows are gone, so it cannot be read. view=history and view=spend still count it.`,
      };
    }
    if (run.teamId === null) {
      return {
        error: 'NOT_A_TEAM_RUN',
        message: `${runId} is a chat of no team: this analysis reads only its team's runs.`,
      };
    }
    if (run.teamId !== turn.team.slug) {
      return {
        error: 'OTHER_TEAM_RUN',
        message: `${runId} is a run of another team: this analysis reads only ${turn.team.slug}'s.`,
      };
    }
    const snapshot = await runSnapshotOf(
      { em: this.em, runDao: this.runDao, itemDao: this.itemDao },
      runId,
    );
    if (snapshot.snapshotSeq < 0) {
      return {
        error: 'RUN_EMPTY',
        message: `${runId} has no rows yet.`,
      };
    }
    turn.team.opened ??= new Map();
    const opened = turn.team.opened.get(runId) ?? { runId, ...snapshot };
    turn.team.opened.set(runId, opened);
    return {
      sourceRunId: opened.runId,
      snapshotSeq: opened.snapshotSeq,
      sourceWorking: opened.working,
    };
  }

  /**
   * view=project: every project the analysed runs belong to, with its
   * description and instructions as they stand now and the revision a write
   * must quote, each run's start copy where its text differs from now (a
   * rename alone is no difference), and the project's newest changes with who
   * made them. Masked whole, then paged.
   */
  private async project(turn: AnalysisReadScope): Promise<Answer> {
    const em = this.em.fork();
    const runIds = analysedRunIdsOf(turn);
    const byProject = new Map<string, { project: Project; runs: Answer[] }>();
    const withoutProject: string[] = [];
    for (const runId of runIds) {
      const run = await this.runDao.getById(runId, em);
      const project = run ? await this.projectScope.projectOfRun(run) : null;
      if (run === null || project === null) {
        withoutProject.push(runId);
        continue;
      }
      const entry = byProject.get(project.id) ?? { project, runs: [] };
      const differs =
        projectInstructionsBody(run.projectInstructions) !==
        projectInstructionsBody(projectInstructionsText(project));
      entry.runs.push({
        runId,
        title: run.title,
        startedWith: differs
          ? (run.projectInstructions ??
            '(nothing — the project said nothing then)')
          : 'the same text as now',
      });
      byProject.set(project.id, entry);
    }
    const projects: Answer[] = [];
    for (const { project, runs } of byProject.values()) {
      const changes = await this.projectChanges.recentFor(
        project.id,
        PROJECT_VIEW_CHANGES,
        em,
      );
      const blocks = projectBlocksOf(project);
      projects.push({
        projectId: project.id,
        name: project.name,
        key: project.taskKey,
        instructionsRevision: project.instructionsRevision,
        description: project.description,
        instructionsChars: instructionsLength(blocks),
        instructionsMaxChars: PROJECT_INSTRUCTIONS_MAX,
        instructionBlocks: blocks,
        runs,
        changes: changes.map((change) => ({
          at: change.changedAt.toISOString(),
          field: change.field,
          by: change.source,
          previous: change.previous,
          next: change.next,
          ...(change.recommendationIds.length > 0
            ? { recommendationIds: change.recommendationIds }
            : {}),
          ...(change.chatRunId === null ? {} : { chatRunId: change.chatRunId }),
        })),
      });
    }
    return maskedAnswer({
      projects,
      ...(withoutProject.length > 0
        ? { runsWithoutProject: withoutProject }
        : {}),
      next:
        projects.length === 0
          ? 'The analysed runs belong to no project, so there are no project instructions to improve.'
          : 'A project-instructions recommendation (P-) names its projectId and changes only its instruction blocks (each run receives their texts joined in order, `instructionsChars` of the `instructionsMaxChars` all of them together may hold); once applied it is written with the project’s instructionsRevision as read here.',
    });
  }

  async foldRuns(analysedRuns: readonly AnalysedRun[]): Promise<RunFold[]> {
    const em = this.em.fork();
    const folds: RunFold[] = [];
    for (const analysed of analysedRuns) {
      const run = await this.runDao.getById(analysed.runId, em);
      if (run === null) {
        folds.push({ analysed, run: null, folded: null });
        continue;
      }
      const reading = await this.timelines.read(
        analysed.runId,
        analysed.snapshotSeq,
        analysed.working,
      );
      folds.push({
        analysed,
        run,
        folded:
          reading === null
            ? null
            : {
                runId: run.id,
                turns: reading.fold.turns,
                lanes: reading.fold.lanes,
                calls: reading.fold.calls,
                wallWorkedMs: await this.wallTurns.nodeSums(
                  analysed.runId,
                  em,
                  analysed.snapshotSeq,
                ),
                callWorkedMs: await this.callWorkedMs(
                  analysed.runId,
                  analysed.snapshotSeq,
                  em,
                ),
                costUsd: reading.fold.totals.costUsd,
                version: snapshotVersion(baseTeamSnapshotOf(run)),
                ...configuredModels(run.teamSnapshot),
                timeline: reading.timeline,
              },
      });
    }
    return folds;
  }

  /**
   * A team analysis's runs side by side: each run's totals and outcome,
   * every member's figures, and every member's turns per model — each folded from
   * every row up to that run's snapshot, never from a window.
   */
  private async runs(
    key: string,
    slug: string,
    analysedRuns: readonly AnalysedRun[],
    index: TeamVersionIndex | null,
    population: RecommendationsTeamPopulation | null,
  ): Promise<Answer> {
    const em = this.em.fork();
    const folded: FoldedRun[] = [];
    const runs: Answer[] = [];
    for (const { analysed, run, folded: entry } of await this.foldRuns(
      analysedRuns,
    )) {
      if (run === null) {
        runs.push({ runId: analysed.runId, gone: true });
        continue;
      }
      const outcomes = await this.outcomes.read(
        analysed.runId,
        analysed.snapshotSeq,
        em,
      );
      const pullRequests = outcomes.pullRequests.flatMap(
        ({ outcomes: [newest], ...pullRequest }) =>
          newest === undefined
            ? []
            : [
                {
                  pullRequest: pullRequestOutcomeKey(pullRequest),
                  acceptance: newest.acceptance,
                  reviewRounds: newest.reviewRounds,
                  draft: newest.draft,
                  changesRequestedRounds: pullRequest.changesRequestedRounds,
                  msToAccepted: pullRequest.msToAccepted,
                },
              ],
      );
      const header = {
        runId: run.id,
        title: run.title,
        createdAt: run.createdAt.toISOString(),
        statusNow: run.status,
        version: versionRef(
          entry === null
            ? snapshotVersion(baseTeamSnapshotOf(run))
            : entry.version,
          index,
        ),
        snapshotSeq: analysed.snapshotSeq,
        workingAtSnapshot: analysed.working,
        questionsAsked: outcomes.questionsAsked,
      };
      if (entry === null) {
        runs.push({ ...header, note: 'The run has no rows yet.' });
        continue;
      }
      folded.push(entry);
      runs.push({
        ...header,
        ...runFigures(entry),
        nodes: runNodeFigures(entry),
        ...(pullRequests.length === 0 ? {} : { pullRequests }),
      });
    }
    // Masked BEFORE it is kept and cut into pages: a secret split across two
    // chunks matches in neither, and the per-page pass would let both out.
    const answer = maskedAnswer({
      team: slug,
      currentVersion: index === null ? null : versionRef(index.current, index),
      runsRead: runs.length,
      population,
      runs,
      versions: versionFigures(folded, index),
      nodes: nodeFigures(folded),
      calls: callFigures(folded),
      models: modelFigures(folded),
      next: "Read one run with runId: view=overview runId=…, then view=spans / view=items / view=item. view=team runId=… is the team as the library holds it now, against that run's copy. view=history is every version of the team, the changes made to it and why, and the earlier analyses' recommendations with what became of them. view=runs section=otherRuns lists the team's other runs, any of which runId opens: read one only for a concrete question these leave open.",
    });
    this.runsAnswers.delete(key);
    this.runsAnswers.set(key, { at: Date.now(), answer });
    for (const stale of [...this.runsAnswers.keys()].slice(
      0,
      Math.max(0, this.runsAnswers.size - RUNS_ANSWERS_KEPT),
    )) {
      this.runsAnswers.delete(stale);
    }
    return answer;
  }

  /**
   * The comparison kept for this run set while it is being paged, its time
   * renewed by every read, or null once it lapsed.
   */
  private keptRuns(key: string): Answer | null {
    const kept = this.runsAnswers.get(key);
    this.runsAnswers.delete(key);
    if (kept === undefined || Date.now() - kept.at >= RUNS_ANSWER_TTL_MS) {
      return null;
    }
    this.runsAnswers.set(key, { at: Date.now(), answer: kept.answer });
    return kept.answer;
  }

  /**
   * The library slug and run-start snapshot of a TEAM source, or null for
   * a plain chat (or a source that is gone).
   */
  async teamOf(sourceRunId: string): Promise<AnalysedTeamRef | null> {
    const run = await this.runDao.getById(sourceRunId, this.em.fork());
    if (run === null || run.teamId === null) {
      return null;
    }
    return {
      slug: run.teamId,
      snapshot: run.teamSnapshot,
      baseSnapshot: baseTeamSnapshotOf(run),
      overlaySnapshot: run.teamOverlaySnapshot,
      projectId: run.projectId,
      instructions: {
        customInstructions: run.customInstructions,
        replyLanguage: run.replyLanguage,
        taskInstructions: run.taskInstructions,
        projectInstructions: run.projectInstructions,
        memoryIndex: run.memoryIndex,
        knowledgeIndex: run.knowledgeIndex,
      },
    };
  }

  /**
   * The team an analysis may read and change: a team analysis's own,
   * with the start copy of the run read (its newest unless one is named,
   * through `analysedSourceOf`) while that run still exists, else a team
   * source's — null for a plain chat (or a source that is gone).
   */
  async analysedTeamOf(
    turn: AnalysisReadScope,
    /** The analysed run whose start copy the library is set against. */
    read: AnalysisSource = turn,
  ): Promise<AnalysedTeamRef | null> {
    const source = await this.teamOf(read.sourceRunId);
    if (!turn.team) {
      return source;
    }
    return source?.slug === turn.team.slug
      ? source
      : {
          slug: turn.team.slug,
          snapshot: null,
          baseSnapshot: null,
          overlaySnapshot: null,
          instructions: null,
        };
  }

  /** The run's project as the overview names it, or null. */
  private async projectRefOf(
    run: Run,
  ): Promise<{ id: string; name: string } | null> {
    const project = await this.projectScope.projectOfRun(run);
    return project ? { id: project.id, name: project.name } : null;
  }

  private async overview(source: AnalysisSource, run: Run): Promise<Answer> {
    const reading = await this.timelines.read(
      source.sourceRunId,
      source.snapshotSeq,
      source.sourceWorking,
    );
    const teamNotes = await this.itemDao.teamNoteCount(
      source.sourceRunId,
      this.em.fork(),
      source.snapshotSeq,
    );
    const kind = analysedThreadKindOf(run);
    const header = {
      source: {
        runId: run.id,
        title: run.title,
        kind,
        teamId: run.teamId,
        agentKind: run.agentKind,
        model: run.model,
        effort: run.effort,
        // The source's status NOW; whether it was working at the snapshot is
        // `timing.working`.
        statusNow: run.status,
        cwd: run.cwd,
        project: await this.projectRefOf(run),
        createdAt: run.createdAt.toISOString(),
        snapshotSeq: source.snapshotSeq,
        // A team's agents differ per node: view=team lists theirs.
        ...(kind === 'chat' && run.agentKind !== null
          ? {
              userInstructions: await sizedUserInstructionFiles(this.adapters, [
                { agent: run.agentKind, configDir: run.configDir },
              ]),
            }
          : {}),
      },
    };
    if (reading === null) {
      return { ...header, timing: null, note: 'The thread has no rows yet.' };
    }
    const { timeline, fold } = reading;
    const lists = {
      nodes: timeline.nodes.map((node) => ({
        node: laneOf(node.memberId),
        inTurnsMs: node.inTurnsMs,
        busyMs: node.busyMs,
        waitingOnCalleeMs: node.waitingOnCalleeMs,
        waitingOnUserMs: node.waitingOnUserMs,
        turns: node.turns,
        toolCalls: node.toolCalls,
        delegateToolCalls: node.delegateToolCalls,
        toolMs: node.toolMs,
        delegateToolMs: node.delegateToolMs,
        maxContextTokens: maxContext(fold.turns, node.memberId),
        ...usageOf(fold.turns, node.memberId),
      })),
      criticalPath: [...timeline.criticalPath]
        .sort((a, b) => b.durationMs - a.durationMs)
        .map((segment) => ({
          kind: segment.kind,
          node: segment.kind === 'work' ? laneOf(segment.memberId) : null,
          at: iso(segment.startMs),
          ms: segment.durationMs,
        })),
      slowestTools: [...timeline.tools]
        .filter((tool) => tool.durationMs !== null)
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        .map((tool) => ({
          seq: tool.seq,
          node: laneOf(tool.memberId),
          name: tool.name.slice(0, TOOL_NAME_CHARS),
          delegate: tool.delegate,
          ms: tool.durationMs,
          at: iso(tool.startMs),
          ...(tool.failed ? { failed: true } : {}),
        })),
      toolTotals: timeline.toolTotals.map((total) => ({
        node: laneOf(total.memberId),
        name: total.name.slice(0, TOOL_NAME_CHARS),
        delegate: total.delegate,
        calls: total.calls,
        totalMs: total.totalMs,
        maxMs: total.maxMs,
        failed: total.failed,
      })),
    };
    const answer = {
      ...header,
      timing: {
        from: iso(timeline.from),
        to: iso(timeline.to),
        wallMs: timeline.wallMs,
        activeMs: timeline.activeMs,
        waitingOnUserMs: timeline.waitingOnUserMs,
        criticalPathMs: timeline.criticalPathMs,
        criticalPathSegments: timeline.criticalPath.length,
        sinks: timeline.sinks.map((sink) => ({
          node: laneOf(sink.memberId),
          ms: sink.ms,
        })),
        calls: fold.calls.length,
        userWaits: fold.waits.length,
        delegates: fold.delegates.length,
        toolCalls: timeline.tools.filter((tool) => !tool.delegate).length,
        delegateToolCalls: timeline.tools.filter((tool) => tool.delegate)
          .length,
        failedToolCalls: timeline.tools.filter((tool) => tool.failed).length,
        ...usageOf(fold.turns),
        working: fold.working,
      },
      teamNotes,
      ...(await this.measured(source, run, timeline.tools, fold.calls)),
      ...lists,
      next: `Read view=spans for every timed span (kinds=["tool"] with minMs for slow tools), view=items for the rows (afterSeq / fromTime / memberId / kinds), view=item seq=N for one row in full.${teamNotes > 0 ? ' The team notes are view=items kinds=["team_note"].' : ''}`,
    };
    return fitToBudget(
      withClippedGoalEvidence(answer, OVERVIEW_BYTES),
      ['goals', 'slowestTools', 'toolTotals', 'criticalPath'],
      OVERVIEW_BYTES,
      ['nodes', 'stages', 'calls'],
    );
  }

  /**
   * What the thread set out to do and how it ended — its goals with their evidence and
   * its outcome — and what it used: each MCP server's calls, its stage moves and the
   * calls between its members, over its rows up to the snapshot.
   */
  private async measured(
    source: AnalysisSource,
    run: Run,
    tools: readonly { name: string; delegate: boolean; failed: boolean }[],
    calls: readonly {
      callerMemberId: string | null;
      calleeMemberId: string | null;
      status: string | null;
      durationMs: number;
    }[],
  ): Promise<Answer> {
    const em = this.em.fork();
    const range = { before: source.snapshotSeq + 1 };
    const goals = (await this.goalDao?.listByRun(source.sourceRunId, em)) ?? [];
    const outcomeRow = (
      await this.itemDao.rowsOfKinds(
        source.sourceRunId,
        ['thread_outcome'],
        range,
        em,
      )
    ).at(-1);
    const recorded =
      outcomeRow === undefined
        ? null
        : ThreadOutcomePayloadSchema.safeParse(
            parseJsonColumn(outcomeRow.payload),
          );
    const outcome =
      recorded?.success === true
        ? {
            kind: recorded.data.kind,
            summary: recorded.data.summary,
            source: 'recorded',
            seq: outcomeRow!.seq,
          }
        : threadOutcomeOf(null, goals);
    const servers = new Map<
      string,
      { calls: number; failed: number; tools: Set<string> }
    >();
    for (const tool of tools) {
      if (tool.delegate) {
        continue;
      }
      const metric = toolMetricOf(
        this.adapters,
        run.id,
        run.agentKind,
        tool.name,
        null,
      );
      if (metric.server === null) {
        continue;
      }
      const server = metric.server;
      const entry = servers.get(server) ?? {
        calls: 0,
        failed: 0,
        tools: new Set(),
      };
      entry.calls += 1;
      entry.failed += tool.failed ? 1 : 0;
      entry.tools.add(metric.tool);
      servers.set(server, entry);
    }
    const stages = (
      await this.itemDao.rowsOfKinds(
        source.sourceRunId,
        ['stage_change'],
        range,
        em,
      )
    ).flatMap((row) => {
      const change = StageChangePayloadSchema.safeParse(
        parseJsonColumn(row.payload),
      );
      return change.success &&
        change.data.action !== 'nudge' &&
        change.data.action !== 'stalled'
        ? [
            {
              seq: row.seq,
              at: row.createdAt.toISOString(),
              action: change.data.action,
              stage: change.data.stageId,
              by:
                change.data.by.kind === 'agent'
                  ? laneOf(change.data.by.nodeId)
                  : change.data.by.kind,
              ...(change.data.lead === undefined
                ? {}
                : { lead: change.data.lead }),
            },
          ]
        : [];
    });
    const pairs = new Map<
      string,
      {
        caller: string;
        callee: string;
        calls: number;
        failed: number;
        totalMs: number;
      }
    >();
    for (const call of calls) {
      const caller = laneOf(call.callerMemberId);
      const callee = laneOf(call.calleeMemberId);
      const key = `${caller}\u0000${callee}`;
      const pair = pairs.get(key) ?? {
        caller,
        callee,
        calls: 0,
        failed: 0,
        totalMs: 0,
      };
      pair.calls += 1;
      pair.failed += call.status !== null && call.status !== 'ok' ? 1 : 0;
      pair.totalMs += call.durationMs;
      pairs.set(key, pair);
    }
    return {
      goals: goals.map((goal) => ({
        id: goalIdOf(goal.number),
        text: goal.text,
        source: goal.source,
        status: goal.status,
        evidence: goal.evidence,
      })),
      outcome,
      mcpServers: [...servers].map(([server, entry]) => ({
        server,
        calls: entry.calls,
        failed: entry.failed,
        tools: [...entry.tools],
      })),
      handOffs: stages.filter((stage) => stage.action === 'handoff').length,
      stages,
      calls: [...pairs.values()],
    };
  }

  private async spans(
    source: AnalysisSource,
    args: ReadAnalyzedThreadArgs,
  ): Promise<Answer> {
    const reading = await this.timelines.read(
      source.sourceRunId,
      source.snapshotSeq,
      source.sourceWorking,
    );
    if (reading === null) {
      return { spans: [], next: null };
    }
    const wanted = new Set(
      (args.kinds ?? DEFAULT_SPAN_KINDS).filter(
        (kind): kind is AnalysisSpanKind =>
          (ANALYSIS_SPAN_KINDS as readonly string[]).includes(kind),
      ),
    );
    const { fold, timeline } = reading;
    const all: (Answer & {
      startMs: number;
      ms: number;
      node: string | null;
    })[] = [];
    if (wanted.has('turn')) {
      for (const turn of fold.turns) {
        all.push({
          type: 'turn',
          node: laneOf(turn.memberId),
          startMs: Date.parse(turn.startedAt),
          ms: turn.durationMs,
          outcome: turn.outcome,
          timing: turn.timingSource,
          model: turn.model,
          toolCalls: turn.toolCalls,
          delegateToolCalls: turn.delegateToolCalls,
          contextTokens: turn.contextTokens,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          costUsd: turn.costUsd,
          // The part of that cost geniro priced from tokens, not the CLI's bill.
          ...(turn.estimatedCostUsd === null
            ? {}
            : { estimatedCostUsd: turn.estimatedCostUsd }),
          ...(turn.modelCosts === null ? {} : { modelCosts: turn.modelCosts }),
        });
      }
    }
    if (wanted.has('call')) {
      const worked = await this.callWorkedMs(
        source.sourceRunId,
        source.snapshotSeq,
        this.em.fork(),
      );
      for (const call of fold.calls) {
        all.push({
          type: 'call',
          node: laneOf(call.callerMemberId),
          callee: call.calleeMemberId,
          mode: call.mode,
          status: call.status,
          running: call.running,
          startMs: Date.parse(call.startedAt),
          ms: call.durationMs,
          // How long the callee worked inside the call, of `ms`; absent when
          // no turn of it was measured.
          ...(worked.has(call.seq) ? { workedMs: worked.get(call.seq) } : {}),
        });
      }
    }
    if (wanted.has('wait')) {
      for (const wait of fold.waits) {
        all.push({
          type: 'wait',
          node: laneOf(wait.memberId),
          question: wait.question,
          toolName: wait.toolName,
          startMs: Date.parse(wait.startedAt),
          ms: wait.durationMs,
        });
      }
    }
    if (wanted.has('delegate')) {
      for (const delegate of fold.delegates) {
        all.push({
          type: 'delegate',
          node: laneOf(delegate.memberId),
          startMs: Date.parse(delegate.startedAt),
          ms: delegate.durationMs,
        });
      }
    }
    if (wanted.has('tool')) {
      for (const tool of timeline.tools) {
        all.push({
          type: 'tool',
          node: laneOf(tool.memberId),
          seq: tool.seq,
          resultSeq: tool.resultSeq,
          name: tool.name.slice(0, TOOL_NAME_CHARS),
          delegate: tool.delegate,
          open: tool.open,
          failed: tool.failed,
          startMs: tool.startMs,
          ms: tool.durationMs ?? 0,
        });
      }
    }
    if (wanted.has('critical')) {
      for (const segment of timeline.criticalPath) {
        all.push({
          type: 'critical',
          kind: segment.kind,
          node: segment.kind === 'work' ? laneOf(segment.memberId) : null,
          startMs: segment.startMs,
          ms: segment.durationMs,
        });
      }
    }
    const filtered = all
      .filter(
        (span) => args.memberId === undefined || span.node === args.memberId,
      )
      .filter((span) => args.minMs === undefined || span.ms >= args.minMs)
      .sort((a, b) => a.startMs - b.startMs);

    const start = args.cursor ?? 0;
    const page: Answer[] = [];
    let used = ENVELOPE_BYTES;
    let index = start;
    for (; index < filtered.length; index += 1) {
      const { startMs, ...span } = filtered[index]!;
      const entry = { at: iso(startMs), ...span };
      const size = bytes(entry) + 1;
      if (page.length > 0 && used + size > PAGE_BYTES) {
        break;
      }
      page.push(entry);
      used += size;
    }
    return {
      total: filtered.length,
      from: start,
      spans: page,
      next: index < filtered.length ? { cursor: index } : null,
    };
  }

  private async items(
    source: AnalysisSource,
    args: ReadAnalyzedThreadArgs,
    em: EntityManager,
  ): Promise<Answer> {
    const fromTime =
      args.fromTime === undefined ? undefined : new Date(args.fromTime);
    if (fromTime !== undefined && Number.isNaN(fromTime.getTime())) {
      return { error: 'INVALID_ARGS', message: 'fromTime is not an ISO time.' };
    }
    const kinds = args.kinds?.filter(
      (kind): kind is ItemKind => ItemKindSchema.safeParse(kind).success,
    );
    const rows = await this.itemDao.analysisPage(
      source.sourceRunId,
      {
        afterSeq: args.afterSeq ?? -1,
        maxSeq: source.snapshotSeq,
        limit: ITEMS_READ_LIMIT,
        ...(fromTime === undefined ? {} : { fromTime }),
        ...(args.memberId === undefined
          ? {}
          : { memberId: args.memberId === CHAT_LANE ? null : args.memberId }),
        ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
      },
      em,
    );
    const page: Answer[] = [];
    let used = ENVELOPE_BYTES;
    let last: number | null = null;
    for (const row of rows) {
      const entry = itemEntry(row);
      const size = bytes(entry) + 1;
      if (page.length > 0 && used + size > PAGE_BYTES) {
        break;
      }
      page.push(entry);
      used += size;
      last = row.seq;
    }
    const more =
      last !== null &&
      (page.length < rows.length ||
        (rows.length === ITEMS_READ_LIMIT && last < source.snapshotSeq));
    return {
      snapshotSeq: source.snapshotSeq,
      items: page,
      next: more ? { afterSeq: last } : null,
    };
  }

  private async item(
    source: AnalysisSource,
    args: ReadAnalyzedThreadArgs,
    em: EntityManager,
  ): Promise<Answer> {
    if (args.seq === undefined) {
      return { error: 'INVALID_ARGS', message: 'view=item needs seq.' };
    }
    if (args.seq > source.snapshotSeq) {
      return {
        error: 'PAST_SNAPSHOT',
        message: `seq ${args.seq} is past this analysis's snapshot (${source.snapshotSeq}).`,
      };
    }
    const row = await this.itemDao.rowAtSeq(source.sourceRunId, args.seq, em);
    if (row === null) {
      return { error: 'NOT_FOUND', message: `no row at seq ${args.seq}.` };
    }
    return chunkOf(
      {
        seq: row.seq,
        kind: row.kind,
        role: row.role,
        node: laneOf(row.memberId),
        at: row.createdAt.toISOString(),
      },
      payloadText(row.payload),
      args.offset ?? 0,
    );
  }
}

/**
 * One page-sized chunk of a long text from `offset`, under `header`. JSON
 * escaping can grow text past its length in characters, so the chunk shrinks
 * until the encoded answer fits a page.
 */
export function chunkOf(header: Answer, text: string, offset: number): Answer {
  const head = { ...header, total: text.length, offset };
  let size = PAGE_BYTES - bytes(head) - ENVELOPE_BYTES;
  for (;;) {
    const chunk = text.slice(offset, offset + size);
    const end = offset + chunk.length;
    const answer = {
      ...head,
      text: chunk,
      next: end < text.length ? { offset: end } : null,
    };
    if (bytes(answer) <= PAGE_BYTES || size <= 1_000) {
      return answer;
    }
    size = Math.floor(size * 0.8);
  }
}

/** An answer as it is, or — past a page — chunked JSON the reader joins. */
export function pagedAnswer(answer: Answer, offset: number): Answer {
  if (offset === 0 && bytes(answer) <= PAGE_BYTES) {
    return answer;
  }
  return chunkOf(
    {
      note: 'This answer is longer than one page: join the `text` of every chunk (follow next.offset), then parse it as JSON.',
    },
    JSON.stringify(answer),
    offset,
  );
}

function itemEntry(row: Item): Answer {
  return {
    seq: row.seq,
    kind: row.kind,
    ...(row.role === null ? {} : { role: row.role }),
    node: laneOf(row.memberId),
    ...(row.inCall === null || row.inCall === '' ? {} : { inCall: row.inCall }),
    at: row.createdAt.toISOString(),
    text: clip(payloadText(row.payload), ITEM_TEXT_CHARS, row.seq),
  };
}

type TurnUsage = Pick<
  RunWaterfallTurn,
  | 'memberId'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'costUsd'
  | 'estimatedCostUsd'
>;

/**
 * The tokens and money the CLI reported, summed over every turn — or one
 * member's when `nodeId` is given. A figure no turn reported stays null: not
 * measured is not zero.
 */
function usageOf(
  turns: readonly TurnUsage[],
  memberId?: string | null,
): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  /** Of {@link costUsd}, the part geniro priced from tokens; null when none. */
  estimatedCostUsd: number | null;
} {
  const own = turns.filter(
    (turn) => memberId === undefined || turn.memberId === memberId,
  );
  const sum = (pick: (turn: TurnUsage) => number | null): number | null =>
    own.reduce<number | null>((total, turn) => {
      const value = pick(turn);
      return value === null ? total : (total ?? 0) + value;
    }, null);
  return {
    inputTokens: sum((turn) => turn.inputTokens),
    outputTokens: sum((turn) => turn.outputTokens),
    cacheReadTokens: sum((turn) => turn.cacheReadTokens),
    costUsd: sum((turn) => turn.costUsd),
    estimatedCostUsd: sum((turn) => turn.estimatedCostUsd),
  };
}

function maxContext(
  turns: readonly { memberId: string | null; contextTokens: number | null }[],
  memberId: string | null,
): number | null {
  let max: number | null = null;
  for (const turn of turns) {
    if (turn.memberId === memberId && turn.contextTokens !== null) {
      max = Math.max(max ?? 0, turn.contextTokens);
    }
  }
  return max;
}

/** An answer past `budget` with each goal's evidence clipped, keeping every goal. */
function withClippedGoalEvidence(answer: Answer, budget: number): Answer {
  const goals = answer.goals;
  if (!Array.isArray(goals) || bytes(answer) <= budget) {
    return answer;
  }
  let clipped = false;
  const shorter = (goals as { evidence: string | null }[]).map((goal) => {
    const evidence = goal.evidence;
    if (evidence === null || evidence.length <= OVERVIEW_GOAL_EVIDENCE_CHARS) {
      return goal;
    }
    clipped = true;
    return {
      ...goal,
      evidence: `${evidence.slice(0, OVERVIEW_GOAL_EVIDENCE_CHARS)}… [+${evidence.length - OVERVIEW_GOAL_EVIDENCE_CHARS} chars]`,
    };
  });
  return clipped
    ? {
        ...answer,
        goals: shorter,
        shortened: {
          goalEvidence: `clipped to ${OVERVIEW_GOAL_EVIDENCE_CHARS} characters each`,
        },
      }
    : answer;
}

/**
 * Shorten the named lists, largest first, until the answer fits `budget`, and
 * touch `lastResort` only once none of `lists` can shrink further. Each list
 * says how much of it was kept, beside whatever `shortened` the answer carries.
 */
export function fitToBudget(
  answer: Answer,
  lists: readonly string[],
  budget: number,
  lastResort: readonly string[] = [],
): Answer {
  const out: Answer = { ...answer };
  const totals = new Map<string, number>();
  for (const key of [...lists, ...lastResort]) {
    const list = out[key];
    if (Array.isArray(list)) {
      totals.set(key, list.length);
    }
  }
  // The `shortened` note is part of what is measured: added after the loop,
  // it could carry a fitted answer past the budget.
  const noted = (candidate: Answer): Answer => {
    const kept: Record<string, unknown> = { ...asRecord(answer.shortened) };
    for (const [key, total] of totals) {
      const length = (candidate[key] as unknown[]).length;
      if (length < total) {
        kept[key] = `${length} of ${total}`;
      }
    }
    return Object.keys(kept).length === 0
      ? candidate
      : { ...candidate, shortened: kept };
  };
  const longestOf = (keys: readonly string[]): string | null => {
    let longest: string | null = null;
    for (const key of keys) {
      const list = out[key];
      if (
        totals.has(key) &&
        (list as unknown[]).length > 1 &&
        (longest === null || bytes(list) > bytes(out[longest]))
      ) {
        longest = key;
      }
    }
    return longest;
  };
  while (bytes(noted(out)) > budget) {
    const longest = longestOf(lists) ?? longestOf(lastResort);
    if (longest === null) {
      break;
    }
    const list = out[longest] as unknown[];
    out[longest] = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
  }
  return noted(out);
}
