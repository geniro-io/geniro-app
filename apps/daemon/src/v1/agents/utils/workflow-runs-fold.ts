import {
  parseWorkflowSnapshot,
  readWorkflowSnapshot,
} from '../../graphs/utils/workflow-snapshot';
import { workflowVersionOf } from '../../graphs/utils/workflow-version';
import type { AgentKind } from '../../runs/runs.types';
import {
  type AnalysedVersionRef,
  type CallFigures,
  type FoldedRun,
  MAX_CARD_AGENT_MODELS,
  MAX_CARD_AGENTS,
  MAX_CARD_CALL_EDGES,
  type ModelFigures,
  type NodeFigures,
  type RecommendationsWorkflowStats,
  type RunFigures,
  type RunNodeFigures,
  type VersionRunFigures,
  type WorkflowVersionIndex,
} from '../chat.types';
import { laneOf } from './analysis-lane';
import { snapshotNodePoolProfiles } from './snapshot-config-dirs';
import { servedWorkedMs } from './wall-worked';

/**
 * What the run's own frozen copy configured each agent node with — the model
 * as the workflow spells it (null: the CLI's default) — and which nodes have a
 * pool, whose turns name no member.
 */
export function configuredModels(
  snapshot: string | null,
): Pick<FoldedRun, 'nodeModels' | 'pooledNodes'> {
  const nodes =
    readWorkflowSnapshot(snapshot)?.nodes.flatMap((node) =>
      node.kind === 'agent' ? [node] : [],
    ) ?? [];
  return {
    nodeModels: new Map(nodes.map((node) => [node.id, node.model ?? null])),
    pooledNodes: new Set(snapshotNodePoolProfiles(snapshot).keys()),
  };
}

/**
 * The graph version a run's frozen copy is — the version the workflow ledger
 * stamps the run with — or null when it keeps no copy the schema can read.
 */
export function snapshotVersion(snapshot: string | null): string | null {
  const reading = parseWorkflowSnapshot(snapshot);
  return reading.state === 'readable'
    ? workflowVersionOf(reading.workflow)
    : null;
}

/** A version named by its number in `index`; without an index, by its hash alone. */
export function versionRef(
  version: string | null,
  index: WorkflowVersionIndex | null,
): AnalysedVersionRef {
  return {
    version,
    number: version === null ? null : (index?.numbers.get(version) ?? null),
    current: version !== null && version === index?.current,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * The analysed runs grouped by the graph version they ran, each group's
 * figures averaged per run — what tells a change's effect from the runs on
 * either side of it. Newest version first: numbered ones by number, then the
 * rest by their newest run.
 */
export function versionFigures(
  runs: readonly FoldedRun[],
  index: WorkflowVersionIndex | null,
): VersionRunFigures[] {
  const groups = new Map<string | null, FoldedRun[]>();
  for (const run of runs) {
    const group = groups.get(run.version) ?? [];
    group.push(run);
    groups.set(run.version, group);
  }
  return [...groups]
    .map(([version, group]): VersionRunFigures => {
      const figures = group.map(runFigures);
      const count = group.length;
      const sum = (pick: (run: RunFigures) => number): number =>
        figures.reduce((total, run) => total + pick(run), 0);
      const priced = figures.flatMap((run) =>
        run.costUsd === null ? [] : [run.costUsd],
      );
      return {
        ...versionRef(version, index),
        runIds: group.map((run) => run.runId),
        avgWallMs: Math.round(sum((run) => run.wallMs) / count),
        medianWallMs: median(figures.map((run) => run.wallMs)),
        avgActiveMs: Math.round(sum((run) => run.activeMs) / count),
        avgCriticalPathMs: Math.round(sum((run) => run.criticalPathMs) / count),
        avgTurns: Math.round((sum((run) => run.turns) / count) * 10) / 10,
        failedTurns: sum((run) => run.failedTurns),
        cancelledTurns: sum((run) => run.cancelledTurns),
        failedToolCalls: sum((run) => run.failedToolCalls),
        avgCalls: Math.round((sum((run) => run.calls) / count) * 10) / 10,
        pricedRuns: priced.length,
        avgCostUsd:
          priced.length === 0
            ? null
            : roundUsd(
                priced.reduce((total, cost) => total + cost, 0) / priced.length,
              ),
      };
    })
    .sort(
      (a, b) =>
        (b.number ?? 0) - (a.number ?? 0) ||
        newestStart(groups.get(b.version)) - newestStart(groups.get(a.version)),
    );
}

function newestStart(runs: readonly FoldedRun[] | undefined): number {
  return Math.max(
    0,
    ...(runs ?? []).flatMap((run) =>
      run.turns.map((turn) => Date.parse(turn.startedAt)),
    ),
  );
}

/** Adds where either side measured something; null only when neither did. */
function plus(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Whether a turn's span is a measurement: its CLI timed it, or status rows
 * bracketed it. A completed turn its CLI did not time is drawn from its lane's
 * previous row so the lane shows — a span that measures nothing.
 */
function timed(turn: FoldedRun['turns'][number]): boolean {
  return turn.timingSource === 'cli' || turn.outcome !== 'completed';
}

/** A lane's working time: its CLI's own, plus the wall clock's for the rest. */
function workedOf(
  run: FoldedRun,
  lane: FoldedRun['lanes'][number],
): number | null {
  return servedWorkedMs(lane.workedMs, run.wallWorkedMs.get(lane.nodeId));
}

function outcomes(turns: FoldedRun['turns']): {
  failedTurns: number;
  cancelledTurns: number;
} {
  return {
    failedTurns: turns.filter((turn) => turn.outcome === 'failed').length,
    cancelledTurns: turns.filter((turn) => turn.outcome === 'cancelled').length,
  };
}

/**
 * One run's totals at its snapshot: its turns as each lane counted them (a
 * turn the card could not draw included) and its whole bill (a polled-spend
 * CLI's included), never re-summed from the drawn spans.
 */
export function runFigures(run: FoldedRun): RunFigures {
  return {
    wallMs: run.timeline.wallMs,
    activeMs: run.timeline.activeMs,
    waitingOnUserMs: run.timeline.waitingOnUserMs,
    criticalPathMs: run.timeline.criticalPathMs,
    turns: run.lanes.reduce((total, lane) => total + lane.turns, 0),
    ...outcomes(run.turns),
    failedToolCalls: run.timeline.tools.filter((tool) => tool.failed).length,
    calls: run.calls.length,
    costUsd: run.costUsd,
  };
}

/**
 * Every node's work in one run: its lane's turns, working time, tool calls and
 * bill, and — when every one of its turns has a measured span — from the
 * timeline the wall time its turns spent working or blocked, and its share of
 * the critical path. Ordered by node.
 */
export function runNodeFigures(run: FoldedRun): RunNodeFigures[] {
  const times = new Map(run.timeline.nodes.map((node) => [node.nodeId, node]));
  const critical = new Map<string | null, number>();
  for (const segment of run.timeline.criticalPath) {
    if (segment.kind === 'work') {
      critical.set(
        segment.nodeId,
        (critical.get(segment.nodeId) ?? 0) + segment.durationMs,
      );
    }
  }
  return run.lanes
    .map((lane): RunNodeFigures => {
      const turns = run.turns.filter((turn) => turn.nodeId === lane.nodeId);
      const measured = turns.every(timed);
      const time = measured ? times.get(lane.nodeId) : undefined;
      return {
        node: laneOf(lane.nodeId),
        agent: lane.agentKind,
        turns: lane.turns,
        ...outcomes(turns),
        workedMs: workedOf(run, lane),
        busyMs: time === undefined ? null : Math.round(time.busyMs),
        waitingOnCalleeMs:
          time === undefined ? null : Math.round(time.waitingOnCalleeMs),
        waitingOnUserMs:
          time === undefined ? null : Math.round(time.waitingOnUserMs),
        criticalPathMs: measured
          ? Math.round(critical.get(lane.nodeId) ?? 0)
          : null,
        toolCalls: lane.toolCalls,
        failedToolCalls: run.timeline.tools.filter(
          (tool) => tool.nodeId === lane.nodeId && tool.failed,
        ).length,
        costUsd: lane.costUsd === null ? null : roundUsd(lane.costUsd),
        maxContextTokens: turns.reduce<number | null>(
          (max, turn) =>
            turn.contextTokens === null
              ? max
              : Math.max(max ?? 0, turn.contextTokens),
          null,
        ),
      };
    })
    .sort((a, b) => a.node.localeCompare(b.node));
}

/**
 * Every caller→callee edge's agent-to-agent calls over every analysed run:
 * how many, how many failed or were still out, and how long they took.
 * Ordered by total time, longest first.
 */
export function callFigures(runs: readonly FoldedRun[]): CallFigures[] {
  const rows = new Map<string, CallFigures & { runIds: Set<string> }>();
  for (const run of runs) {
    for (const call of run.calls) {
      const caller = laneOf(call.callerNodeId);
      const callee = laneOf(call.calleeNodeId);
      const key = JSON.stringify([caller, callee]);
      const row = rows.get(key) ?? {
        caller,
        callee,
        runs: 0,
        runIds: new Set<string>(),
        calls: 0,
        failedCalls: 0,
        runningCalls: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
      };
      row.runIds.add(run.runId);
      row.calls += 1;
      row.failedCalls += call.status !== null && call.status !== 'ok' ? 1 : 0;
      row.runningCalls += call.running ? 1 : 0;
      row.totalMs += call.durationMs;
      row.maxMs = Math.max(row.maxMs, call.durationMs);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map(({ runIds, ...row }) => ({
      ...row,
      runs: runIds.size,
      avgMs: Math.round(row.totalMs / row.calls),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Every node's work summed over every analysed run, from its lanes: turns,
 * worked time, tool calls and cost as the run's own figures state them.
 */
export function nodeFigures(runs: readonly FoldedRun[]): NodeFigures[] {
  const rows = new Map<string, NodeFigures>();
  const pricedRuns = new Map<string, number>();
  for (const run of runs) {
    for (const lane of run.lanes) {
      const node = laneOf(lane.nodeId);
      const key = JSON.stringify([node, lane.agentKind]);
      const row = rows.get(key) ?? {
        node,
        agent: lane.agentKind,
        runs: 0,
        turns: 0,
        failedTurns: 0,
        cancelledTurns: 0,
        workedMs: null,
        toolCalls: 0,
        costUsd: null,
        costPerRunUsd: null,
      };
      const own = outcomes(
        run.turns.filter((turn) => turn.nodeId === lane.nodeId),
      );
      row.runs += 1;
      row.turns += lane.turns;
      row.failedTurns += own.failedTurns;
      row.cancelledTurns += own.cancelledTurns;
      row.workedMs = plus(row.workedMs, workedOf(run, lane));
      row.toolCalls += lane.toolCalls;
      row.costUsd = plus(row.costUsd, lane.costUsd);
      if (lane.costUsd !== null) {
        pricedRuns.set(key, (pricedRuns.get(key) ?? 0) + 1);
      }
      rows.set(key, row);
    }
  }
  return [...rows.entries()]
    .map(([key, row]) => ({
      ...row,
      costUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
      costPerRunUsd:
        row.costUsd === null
          ? null
          : roundUsd(row.costUsd / (pricedRuns.get(key) ?? 1)),
    }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

/** Which agent ran a turn, as the comparison names it. */
interface TurnIdentity {
  agent: AgentKind | null;
  model: string | null;
  source: ModelFigures['modelSource'];
}

/**
 * The CLI and model each turn ran on. A turn that ended without reporting a
 * model — a failure, a Stop, one still running — ran on the model its node
 * last reported in that run; one before any report is filed under the model
 * the node was configured with, marked so.
 *
 * A pooled node is followed per MEMBER, as the turn's own usage row names it:
 * a pool hands work on exactly when a member fails, so the model reported
 * before or after may be another member's. A pooled turn naming no member is
 * left unattributed.
 */
function turnIdentities(run: FoldedRun): TurnIdentity[] {
  const lanes = new Map(run.lanes.map((lane) => [lane.nodeId, lane.agentKind]));
  const ordered = run.turns
    .map((turn, index) => ({ turn, index }))
    .sort(
      (a, b) =>
        Date.parse(a.turn.startedAt) - Date.parse(b.turn.startedAt) ||
        a.index - b.index,
    );
  const identities: TurnIdentity[] = run.turns.map(() => ({
    agent: null,
    model: null,
    source: 'unreported',
  }));
  const last = new Map<string, string>();
  for (const { turn, index } of ordered) {
    const pooled = run.pooledNodes.has(turn.nodeId);
    const agent = pooled
      ? (turn.member?.agentKind ?? null)
      : (lanes.get(turn.nodeId) ?? null);
    const runner = JSON.stringify([
      turn.nodeId,
      pooled ? (turn.member ?? null) : null,
    ]);
    if (turn.model !== null) {
      last.set(runner, turn.model);
      identities[index] = { agent, model: turn.model, source: 'reported' };
      continue;
    }
    if (pooled && turn.member === null) {
      continue;
    }
    const reported = last.get(runner);
    identities[index] =
      reported !== undefined
        ? { agent, model: reported, source: 'reported' }
        : {
            agent,
            model: pooled
              ? (turn.member?.model ?? null)
              : (run.nodeModels.get(turn.nodeId) ?? null),
            source: 'configured',
          };
  }
  return identities;
}

/**
 * Every node's turns per model, summed over every analysed run — the
 * comparison a workflow analysis judges each agent's model by. The figures
 * are the CLI's own per turn: a polled-spend CLI prices no turn, so its cost
 * here is null and its bill is the node's ({@link nodeFigures}), and a turn
 * its CLI did not time is counted but not timed — its working time is the
 * node's. Ordered by node, then by turns, most first.
 */
export function modelFigures(runs: readonly FoldedRun[]): ModelFigures[] {
  const rows = new Map<string, ModelFigures & { runIds: Set<string> }>();
  for (const run of runs) {
    const identities = turnIdentities(run);
    run.turns.forEach((turn, index) => {
      const node = laneOf(turn.nodeId);
      const { agent, model, source } = identities[index]!;
      const key = JSON.stringify([node, agent, model, source]);
      const row = rows.get(key) ?? {
        node,
        agent,
        model,
        modelSource: source,
        runs: 0,
        runIds: new Set<string>(),
        turns: 0,
        failedTurns: 0,
        cancelledTurns: 0,
        runningTurns: 0,
        timedTurns: 0,
        durationMs: 0,
        avgTurnMs: null,
        toolCalls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        pricedTurns: 0,
        costPerTurnUsd: null,
      };
      row.runIds.add(run.runId);
      row.turns += 1;
      row.failedTurns += turn.outcome === 'failed' ? 1 : 0;
      row.cancelledTurns += turn.outcome === 'cancelled' ? 1 : 0;
      row.runningTurns += turn.outcome === 'running' ? 1 : 0;
      if (timed(turn)) {
        row.timedTurns += 1;
        row.durationMs += turn.durationMs;
      }
      row.toolCalls += turn.toolCalls;
      row.inputTokens = plus(row.inputTokens, turn.inputTokens);
      row.outputTokens = plus(row.outputTokens, turn.outputTokens);
      row.costUsd = plus(row.costUsd, turn.costUsd);
      row.pricedTurns += turn.costUsd === null ? 0 : 1;
      rows.set(key, row);
    });
  }
  return [...rows.values()]
    .map(({ runIds, ...row }) => ({
      ...row,
      runs: runIds.size,
      durationMs: Math.round(row.durationMs),
      avgTurnMs:
        row.timedTurns === 0
          ? null
          : Math.round(row.durationMs / row.timedTurns),
      costUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
      costPerTurnUsd:
        row.costUsd === null || row.pricedTurns === 0
          ? null
          : roundUsd(row.costUsd / row.pricedTurns),
    }))
    .sort((a, b) => a.node.localeCompare(b.node) || b.turns - a.turns);
}

type CardAgentStats = RecommendationsWorkflowStats['agents'][number];

interface Measured {
  total: number | null;
  runs: number;
}

function measure(measured: Measured, value: number | null): Measured {
  return value === null
    ? measured
    : { total: (measured.total ?? 0) + value, runs: measured.runs + 1 };
}

function perMeasuredRun(measured: Measured): number | null {
  return measured.total === null ? null : measured.total / measured.runs;
}

const UNMEASURED: Measured = { total: null, runs: 0 };

function cardAgentStats(runs: readonly FoldedRun[]): CardAgentStats[] {
  const rows = new Map<
    string,
    {
      node: string;
      agent: CardAgentStats['agent'];
      runs: number;
      turns: number;
      failedTurns: number;
      cancelledTurns: number;
      worked: Measured;
      waitingOnCallee: Measured;
      criticalPath: Measured;
      toolCalls: number;
      failedToolCalls: number;
      cost: Measured;
      maxContextTokens: number | null;
    }
  >();
  for (const run of runs) {
    for (const node of runNodeFigures(run)) {
      const row = rows.get(node.node) ?? {
        node: node.node,
        agent: node.agent,
        runs: 0,
        turns: 0,
        failedTurns: 0,
        cancelledTurns: 0,
        worked: UNMEASURED,
        waitingOnCallee: UNMEASURED,
        criticalPath: UNMEASURED,
        toolCalls: 0,
        failedToolCalls: 0,
        cost: UNMEASURED,
        maxContextTokens: null,
      };
      row.agent ??= node.agent;
      row.runs += 1;
      row.turns += node.turns;
      row.failedTurns += node.failedTurns;
      row.cancelledTurns += node.cancelledTurns;
      row.worked = measure(row.worked, node.workedMs);
      row.waitingOnCallee = measure(
        row.waitingOnCallee,
        node.waitingOnCalleeMs,
      );
      row.criticalPath = measure(row.criticalPath, node.criticalPathMs);
      row.toolCalls += node.toolCalls;
      row.failedToolCalls += node.failedToolCalls;
      row.cost = measure(row.cost, node.costUsd);
      row.maxContextTokens =
        node.maxContextTokens === null
          ? row.maxContextTokens
          : Math.max(row.maxContextTokens ?? 0, node.maxContextTokens);
      rows.set(node.node, row);
    }
  }
  const models = modelFigures(runs);
  const round = (value: number | null): number | null =>
    value === null ? null : Math.round(value);
  return [...rows.values()]
    .map((row): CardAgentStats => ({
      node: row.node,
      agent: row.agent,
      runs: row.runs,
      turns: row.turns,
      failedTurns: row.failedTurns,
      cancelledTurns: row.cancelledTurns,
      workedMs: round(row.worked.total),
      workedPerRunMs: round(perMeasuredRun(row.worked)),
      waitingOnCalleePerRunMs: round(perMeasuredRun(row.waitingOnCallee)),
      criticalPathPerRunMs: round(perMeasuredRun(row.criticalPath)),
      toolCalls: row.toolCalls,
      failedToolCalls: row.failedToolCalls,
      costUsd: row.cost.total === null ? null : roundUsd(row.cost.total),
      costPerRunUsd:
        row.cost.total === null
          ? null
          : roundUsd(row.cost.total / row.cost.runs),
      maxContextTokens: row.maxContextTokens,
      models: models
        .filter((model) => model.node === row.node)
        .slice(0, MAX_CARD_AGENT_MODELS)
        .map((model) => ({
          agent: model.agent,
          model: model.model,
          modelSource: model.modelSource,
          turns: model.turns,
          failedTurns: model.failedTurns,
          cancelledTurns: model.cancelledTurns,
          avgTurnMs: model.avgTurnMs,
          costUsd: model.costUsd,
          costPerTurnUsd: model.costPerTurnUsd,
        })),
    }))
    .sort(
      (a, b) =>
        (b.workedMs ?? -1) - (a.workedMs ?? -1) || a.node.localeCompare(b.node),
    )
    .slice(0, MAX_CARD_AGENTS);
}

export function workflowCardStats(
  runs: readonly { title: string | null; createdAt: Date; folded: FoldedRun }[],
  index: WorkflowVersionIndex | null,
): RecommendationsWorkflowStats | null {
  if (runs.length === 0) {
    return null;
  }
  const folded = runs.map((run) => run.folded);
  const figures = folded.map(runFigures);
  const edges = callFigures(folded);
  const count = runs.length;
  const sum = (pick: (run: RunFigures) => number): number =>
    figures.reduce((total, run) => total + pick(run), 0);
  const average = (pick: (run: RunFigures) => number): number =>
    Math.round(sum(pick) / count);
  const priced = figures.flatMap((run) =>
    run.costUsd === null ? [] : [run.costUsd],
  );
  const cost =
    priced.length === 0
      ? null
      : priced.reduce((total, value) => total + value, 0);
  return {
    runs: count,
    perRun: {
      wallMs: average((run) => run.wallMs),
      activeMs: average((run) => run.activeMs),
      waitingOnUserMs: average((run) => run.waitingOnUserMs),
      criticalPathMs: average((run) => run.criticalPathMs),
      turns: Math.round((sum((run) => run.turns) / count) * 10) / 10,
      calls: Math.round((sum((run) => run.calls) / count) * 10) / 10,
      costUsd: cost === null ? null : roundUsd(cost / priced.length),
      pricedRuns: priced.length,
    },
    totals: {
      wallMs: Math.round(sum((run) => run.wallMs)),
      activeMs: Math.round(sum((run) => run.activeMs)),
      turns: sum((run) => run.turns),
      failedTurns: sum((run) => run.failedTurns),
      cancelledTurns: sum((run) => run.cancelledTurns),
      toolCalls: folded.reduce(
        (total, run) =>
          total + run.lanes.reduce((lanes, lane) => lanes + lane.toolCalls, 0),
        0,
      ),
      failedToolCalls: sum((run) => run.failedToolCalls),
      calls: sum((run) => run.calls),
      costUsd: cost === null ? null : roundUsd(cost),
    },
    runList: runs.map(({ title, createdAt, folded: run }, position) => {
      const own = figures[position]!;
      const version = versionRef(run.version, index);
      return {
        runId: run.runId,
        title,
        createdAt: createdAt.toISOString(),
        version: version.number,
        current: version.current,
        wallMs: Math.round(own.wallMs),
        activeMs: Math.round(own.activeMs),
        waitingOnUserMs: Math.round(own.waitingOnUserMs),
        turns: own.turns,
        failedTurns: own.failedTurns,
        costUsd: own.costUsd === null ? null : roundUsd(own.costUsd),
      };
    }),
    agents: cardAgentStats(folded),
    callEdges: edges.length,
    calls: edges.slice(0, MAX_CARD_CALL_EDGES).map((call) => ({
      caller: call.caller,
      callee: call.callee,
      calls: call.calls,
      failedCalls: call.failedCalls,
      totalMs: Math.round(call.totalMs),
      avgMs: call.avgMs,
      maxMs: Math.round(call.maxMs),
    })),
  };
}
