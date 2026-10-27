import { readWorkflowSnapshot } from '../../graphs/utils/workflow-snapshot';
import type {
  FoldedRun,
  ModelFigures,
  NodeFigures,
  RunFigures,
} from '../chat.types';
import { laneOf } from './analysis-lane';

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
    pooledNodes: new Set(
      nodes
        .filter((node) => (node.pool?.length ?? 0) > 0)
        .map((node) => node.id),
    ),
  };
}

/** Adds where either side measured something; null only when neither did. */
function plus(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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
    turns: run.lanes.reduce((total, lane) => total + lane.turns, 0),
    ...outcomes(run.turns),
    failedToolCalls: run.timeline.tools.filter((tool) => tool.failed).length,
    costUsd: run.costUsd,
  };
}

/**
 * Every node's work summed over every analysed run, from its lanes: turns,
 * worked time, tool calls and cost as the run's own figures state them.
 */
export function nodeFigures(runs: readonly FoldedRun[]): NodeFigures[] {
  const rows = new Map<string, NodeFigures>();
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
      row.workedMs = plus(row.workedMs, lane.workedMs);
      row.toolCalls += lane.toolCalls;
      row.costUsd = plus(row.costUsd, lane.costUsd);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      costUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
      costPerRunUsd:
        row.costUsd === null ? null : roundUsd(row.costUsd / row.runs),
    }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

/**
 * The model each turn ran on. A turn that ended without reporting one — a
 * failure, a Stop, one still running — ran on the model its node last
 * reported in that run. One that came before any report is filed under the
 * model the node was configured with, marked so: a pool hands work on exactly
 * when a member fails before reporting, so the NEXT model reported may be
 * another member's. A pooled node's turn names no member, so one that
 * reported nothing is left unattributed.
 */
function turnModels(
  run: FoldedRun,
): { model: string | null; source: ModelFigures['modelSource'] }[] {
  const ordered = run.turns
    .map((turn, index) => ({ turn, index }))
    .sort(
      (a, b) =>
        Date.parse(a.turn.startedAt) - Date.parse(b.turn.startedAt) ||
        a.index - b.index,
    );
  const models = run.turns.map((turn) => ({
    model: turn.model,
    source: 'reported' as ModelFigures['modelSource'],
  }));
  const last = new Map<string | null, string>();
  for (const { turn, index } of ordered) {
    if (turn.model !== null) {
      last.set(turn.nodeId, turn.model);
      continue;
    }
    if (run.pooledNodes.has(turn.nodeId)) {
      models[index] = { model: null, source: 'unreported' };
      continue;
    }
    const reported = last.get(turn.nodeId);
    models[index] =
      reported === undefined
        ? {
            model: run.nodeModels.get(turn.nodeId) ?? null,
            source: 'configured',
          }
        : { model: reported, source: 'reported' };
  }
  return models;
}

/**
 * Every node's turns per model, summed over every analysed run — the
 * comparison a workflow analysis judges each agent's model by. The figures
 * are the CLI's own per turn: a polled-spend CLI prices no turn, so its cost
 * here is null and its bill is the node's ({@link nodeFigures}). Ordered by
 * node, then by turns, most first.
 */
export function modelFigures(runs: readonly FoldedRun[]): ModelFigures[] {
  const rows = new Map<string, ModelFigures & { runIds: Set<string> }>();
  for (const run of runs) {
    const models = turnModels(run);
    run.turns.forEach((turn, index) => {
      const node = laneOf(turn.nodeId);
      const { model, source } = models[index]!;
      const key = JSON.stringify([node, model, source]);
      const row = rows.get(key) ?? {
        node,
        model,
        modelSource: source,
        runs: 0,
        runIds: new Set<string>(),
        turns: 0,
        failedTurns: 0,
        cancelledTurns: 0,
        runningTurns: 0,
        durationMs: 0,
        avgTurnMs: 0,
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
      row.durationMs += turn.durationMs;
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
      avgTurnMs: Math.round(row.durationMs / row.turns),
      costUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
      costPerTurnUsd:
        row.costUsd === null || row.pricedTurns === 0
          ? null
          : roundUsd(row.costUsd / row.pricedTurns),
    }))
    .sort((a, b) => a.node.localeCompare(b.node) || b.turns - a.turns);
}
