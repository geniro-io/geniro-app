import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import { type ItemKind, ItemKindSchema } from '../../runs/runs.types';
import {
  type AnalysedWorkflowRef,
  ANALYSIS_SPAN_KINDS,
  type AnalysisReadScope,
  type AnalysisSource,
  type AnalysisSpanKind,
  type FoldedRun,
  type ReadAnalyzedThreadArgs,
  type RunWaterfallTurn,
  type WorkflowVersionIndex,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { analysedSourceOf } from '../utils/analysed-runs';
import { CHAT_LANE, laneOf } from '../utils/analysis-lane';
import { collapseImageBlocks } from '../utils/collapse-image-blocks';
import { asRecord } from '../utils/json-util';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import { analysedThreadKindOf } from '../utils/thread-analysis-guide';
import { sizedUserInstructionFiles } from '../utils/user-instruction-files';
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
} from '../utils/workflow-runs-fold';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { RunOutcomeHistoryService } from './run-outcome-history.service';
import { ThreadTimelineService } from './thread-timeline.service';

/** The overview's byte budget — small enough to read whole, first. */
export const OVERVIEW_BYTES = 12_000;

/**
 * A page's byte budget. Under the ~10k-token cut codex applies to one tool
 * result, with room for the data line the tool puts in front of it.
 */
export const PAGE_BYTES = 22_000;

/** Room a page keeps for its envelope (`total`, `next`, …) around the entries. */
const ENVELOPE_BYTES = 200;

/** A tool's name as a page names it — ACP titles a shell call with its command. */
const TOOL_NAME_CHARS = 80;

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

function bytes(value: unknown): number {
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
  ) {}

  async read(
    turn: AnalysisReadScope,
    args: ReadAnalyzedThreadArgs,
    /**
     * The workflow's version numbers, which the stats module keeps; without
     * it, or when it fails, view=runs names each run's version by hash alone.
     */
    versionIndex:
      ((slug: string) => Promise<WorkflowVersionIndex>) | null = null,
  ): Promise<Answer> {
    if (args.view === 'history') {
      return {
        error: 'UNSUPPORTED',
        message: 'The history view is answered by the tool, not the reader.',
      };
    }
    if (args.view === 'runs') {
      if (!turn.workflow) {
        return {
          error: 'UNSUPPORTED',
          message:
            'view=runs compares the runs of a workflow analysis; this one reads one thread — start with view=overview.',
        };
      }
      const offset = args.offset ?? 0;
      const key = JSON.stringify([turn.workflow.slug, turn.workflow.runs]);
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
            turn.workflow.slug,
            turn.workflow.runs,
            versionIndex === null
              ? null
              : await versionIndex(turn.workflow.slug).catch(() => null),
          )),
        offset,
      );
    }
    const source = analysedSourceOf(turn, args.runId);
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
      case 'workflow':
        return {
          error: 'UNSUPPORTED',
          message: 'The workflow view is answered by the tool, not the reader.',
        };
    }
  }

  /**
   * A workflow analysis's runs side by side: each run's totals and outcome,
   * every node's figures, and every node's turns per model — each folded from
   * every row up to that run's snapshot, never from a window.
   */
  private async runs(
    key: string,
    slug: string,
    analysedRuns: NonNullable<AnalysisReadScope['workflow']>['runs'],
    index: WorkflowVersionIndex | null,
  ): Promise<Answer> {
    const em = this.em.fork();
    const folded: FoldedRun[] = [];
    const runs: Answer[] = [];
    for (const analysed of analysedRuns) {
      const run = await this.runDao.getById(analysed.runId, em);
      if (run === null) {
        runs.push({ runId: analysed.runId, gone: true });
        continue;
      }
      const reading = await this.timelines.read(
        analysed.runId,
        analysed.snapshotSeq,
        analysed.working,
      );
      const version = snapshotVersion(run.workflowSnapshot);
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
        version: versionRef(version, index),
        snapshotSeq: analysed.snapshotSeq,
        workingAtSnapshot: analysed.working,
        questionsAsked: outcomes.questionsAsked,
      };
      if (reading === null) {
        runs.push({ ...header, note: 'The run has no rows yet.' });
        continue;
      }
      const entry: FoldedRun = {
        runId: run.id,
        turns: reading.fold.turns,
        lanes: reading.fold.lanes,
        calls: reading.fold.calls,
        wallWorkedMs: await this.wallTurns.nodeSums(
          analysed.runId,
          em,
          analysed.snapshotSeq,
        ),
        costUsd: reading.fold.totals.costUsd,
        version,
        ...configuredModels(run.workflowSnapshot),
        timeline: reading.timeline,
      };
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
      workflow: slug,
      currentVersion: index === null ? null : versionRef(index.current, index),
      runs,
      versions: versionFigures(folded, index),
      nodes: nodeFigures(folded),
      calls: callFigures(folded),
      models: modelFigures(folded),
      next: "Read one run with runId: view=overview runId=…, then view=spans / view=items / view=item. view=workflow runId=… is the workflow as the library holds it now, against that run's copy. view=history is every version of the workflow, the changes made to it and why, and the earlier analyses' recommendations with what became of them.",
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
   * The library slug and run-start snapshot of a WORKFLOW source, or null for
   * a plain chat (or a source that is gone).
   */
  async workflowOf(sourceRunId: string): Promise<AnalysedWorkflowRef | null> {
    const run = await this.runDao.getById(sourceRunId, this.em.fork());
    if (run === null || run.workflowId === null) {
      return null;
    }
    return {
      slug: run.workflowId,
      snapshot: run.workflowSnapshot,
      instructions: {
        customInstructions: run.customInstructions,
        replyLanguage: run.replyLanguage,
        taskInstructions: run.taskInstructions,
        memoryIndex: run.memoryIndex,
      },
    };
  }

  /**
   * The workflow an analysis may read and change: a workflow analysis's own,
   * with the start copy of the run read (its newest unless one is named,
   * through `analysedSourceOf`) while that run still exists, else a workflow
   * source's — null for a plain chat (or a source that is gone).
   */
  async analysedWorkflowOf(
    turn: AnalysisReadScope,
    /** The analysed run whose start copy the library is set against. */
    read: AnalysisSource = turn,
  ): Promise<AnalysedWorkflowRef | null> {
    const source = await this.workflowOf(read.sourceRunId);
    if (!turn.workflow) {
      return source;
    }
    return source?.slug === turn.workflow.slug
      ? source
      : { slug: turn.workflow.slug, snapshot: null, instructions: null };
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
        workflowId: run.workflowId,
        agentKind: run.agentKind,
        model: run.model,
        effort: run.effort,
        // The source's status NOW; whether it was working at the snapshot is
        // `timing.working`.
        statusNow: run.status,
        cwd: run.cwd,
        createdAt: run.createdAt.toISOString(),
        snapshotSeq: source.snapshotSeq,
        // A workflow's agents differ per node: view=workflow lists theirs.
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
        node: laneOf(node.nodeId),
        inTurnsMs: node.inTurnsMs,
        busyMs: node.busyMs,
        waitingOnCalleeMs: node.waitingOnCalleeMs,
        waitingOnUserMs: node.waitingOnUserMs,
        turns: node.turns,
        toolCalls: node.toolCalls,
        delegateToolCalls: node.delegateToolCalls,
        toolMs: node.toolMs,
        delegateToolMs: node.delegateToolMs,
        maxContextTokens: maxContext(fold.turns, node.nodeId),
        ...usageOf(fold.turns, node.nodeId),
      })),
      criticalPath: [...timeline.criticalPath]
        .sort((a, b) => b.durationMs - a.durationMs)
        .map((segment) => ({
          kind: segment.kind,
          node: segment.kind === 'work' ? laneOf(segment.nodeId) : null,
          at: iso(segment.startMs),
          ms: segment.durationMs,
        })),
      slowestTools: [...timeline.tools]
        .filter((tool) => tool.durationMs !== null)
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        .map((tool) => ({
          seq: tool.seq,
          node: laneOf(tool.nodeId),
          name: tool.name.slice(0, TOOL_NAME_CHARS),
          delegate: tool.delegate,
          ms: tool.durationMs,
          at: iso(tool.startMs),
          ...(tool.failed ? { failed: true } : {}),
        })),
      toolTotals: timeline.toolTotals.map((total) => ({
        node: laneOf(total.nodeId),
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
          node: laneOf(sink.nodeId),
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
      ...lists,
      next: `Read view=spans for every timed span (kinds=["tool"] with minMs for slow tools), view=items for the rows (afterSeq / fromTime / nodeId / kinds), view=item seq=N for one row in full.${teamNotes > 0 ? ' The team notes are view=items kinds=["team_note"].' : ''}`,
    };
    return fitToBudget(
      answer,
      ['slowestTools', 'toolTotals', 'criticalPath', 'nodes'],
      OVERVIEW_BYTES,
    );
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
          node: laneOf(turn.nodeId),
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
      for (const call of fold.calls) {
        all.push({
          type: 'call',
          node: laneOf(call.callerNodeId),
          callee: call.calleeNodeId,
          mode: call.mode,
          status: call.status,
          running: call.running,
          startMs: Date.parse(call.startedAt),
          ms: call.durationMs,
        });
      }
    }
    if (wanted.has('wait')) {
      for (const wait of fold.waits) {
        all.push({
          type: 'wait',
          node: laneOf(wait.nodeId),
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
          node: laneOf(delegate.nodeId),
          startMs: Date.parse(delegate.startedAt),
          ms: delegate.durationMs,
        });
      }
    }
    if (wanted.has('tool')) {
      for (const tool of timeline.tools) {
        all.push({
          type: 'tool',
          node: laneOf(tool.nodeId),
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
          node: segment.kind === 'work' ? laneOf(segment.nodeId) : null,
          startMs: segment.startMs,
          ms: segment.durationMs,
        });
      }
    }
    const filtered = all
      .filter((span) => args.nodeId === undefined || span.node === args.nodeId)
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
        ...(args.nodeId === undefined
          ? {}
          : { nodeId: args.nodeId === CHAT_LANE ? null : args.nodeId }),
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
        node: laneOf(row.nodeId),
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
    node: laneOf(row.nodeId),
    ...(row.inCall === null || row.inCall === '' ? {} : { inCall: row.inCall }),
    at: row.createdAt.toISOString(),
    text: clip(payloadText(row.payload), ITEM_TEXT_CHARS, row.seq),
  };
}

type TurnUsage = Pick<
  RunWaterfallTurn,
  | 'nodeId'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'costUsd'
  | 'estimatedCostUsd'
>;

/**
 * The tokens and money the CLI reported, summed over every turn — or one
 * node's when `nodeId` is given. A figure no turn reported stays null: not
 * measured is not zero.
 */
function usageOf(
  turns: readonly TurnUsage[],
  nodeId?: string | null,
): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  /** Of {@link costUsd}, the part geniro priced from tokens; null when none. */
  estimatedCostUsd: number | null;
} {
  const own = turns.filter(
    (turn) => nodeId === undefined || turn.nodeId === nodeId,
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
  turns: readonly { nodeId: string | null; contextTokens: number | null }[],
  nodeId: string | null,
): number | null {
  let max: number | null = null;
  for (const turn of turns) {
    if (turn.nodeId === nodeId && turn.contextTokens !== null) {
      max = Math.max(max ?? 0, turn.contextTokens);
    }
  }
  return max;
}

/**
 * Shorten the named lists, largest first, until the answer fits `budget`.
 * Each list says how much of it was kept.
 */
export function fitToBudget(
  answer: Answer,
  lists: readonly string[],
  budget: number,
): Answer {
  const out: Answer = { ...answer };
  const totals = new Map<string, number>();
  for (const key of lists) {
    const list = out[key];
    if (Array.isArray(list)) {
      totals.set(key, list.length);
    }
  }
  // The `shortened` note is part of what is measured: added after the loop,
  // it could carry a fitted answer past the budget.
  const noted = (candidate: Answer): Answer => {
    const kept: Record<string, string> = {};
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
  while (bytes(noted(out)) > budget) {
    let longest: string | null = null;
    for (const key of totals.keys()) {
      const list = out[key] as unknown[];
      if (
        list.length > 1 &&
        (longest === null || bytes(list) > bytes(out[longest]))
      ) {
        longest = key;
      }
    }
    if (longest === null) {
      break;
    }
    const list = out[longest] as unknown[];
    out[longest] = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
  }
  return noted(out);
}
