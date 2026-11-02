import { outcomeKindFromGoals } from '../../agents/utils/run-goals';
import type {
  CallLedgerRow,
  GoalLedgerRow,
  McpServerUseWire,
  MemberCallWire,
  StageFiguresWire,
  StageLedgerRow,
  ThreadMetricsWire,
  ThreadOutcomeLedgerRow,
  ToolCallLedgerRow,
  ToolUseWire,
} from '../stats.types';

export interface ThreadMetricsInput {
  /** The runs the figures describe; the ledger rows of any other run are left out. */
  runs: readonly { runId: string; metrics?: boolean }[];
  goals: readonly GoalLedgerRow[];
  threadOutcomes: readonly ThreadOutcomeLedgerRow[];
  toolCalls: readonly ToolCallLedgerRow[];
  stages: readonly StageLedgerRow[];
  calls: readonly CallLedgerRow[];
}

/**
 * The thread metrics of a set of runs, folded over every ledger row they left —
 * a deleted run's included. A figure no measured run could carry is null, never 0.
 */
export function foldThreadMetrics(
  input: ThreadMetricsInput,
): ThreadMetricsWire {
  const runIds = new Set(input.runs.map((run) => run.runId));
  const measured = new Set(
    input.runs.filter((run) => run.metrics === true).map((run) => run.runId),
  );
  const measuredRuns = measured.size;
  const goals = input.goals.filter((goal) => runIds.has(goal.runId));

  const goalsByRun = new Map<string, GoalLedgerRow[]>();
  for (const goal of goals) {
    const list = goalsByRun.get(goal.runId) ?? [];
    list.push(goal);
    goalsByRun.set(goal.runId, list);
  }
  const counted = goals.filter((goal) => goal.status !== 'dropped');
  const achieved = goals.filter((goal) => goal.status === 'achieved').length;

  const recorded = new Map<string, ThreadOutcomeLedgerRow>();
  for (const outcome of input.threadOutcomes) {
    if (runIds.has(outcome.runId)) {
      recorded.set(outcome.runId, outcome);
    }
  }
  const outcomes = {
    success: 0,
    partial: 0,
    failed: 0,
    abandoned: 0,
    recorded: 0,
    derived: 0,
  };
  for (const runId of runIds) {
    const kind =
      recorded.get(runId)?.kind ??
      outcomeKindFromGoals(goalsByRun.get(runId) ?? []);
    if (kind === null) {
      continue;
    }
    outcomes[kind] += 1;
    if (recorded.has(runId)) {
      outcomes.recorded += 1;
    } else {
      outcomes.derived += 1;
    }
  }

  const stages = input.stages.filter((row) => runIds.has(row.runId));
  return {
    goals: {
      recorded: goals.length,
      achieved,
      notAchieved: goals.filter((goal) => goal.status === 'not_achieved')
        .length,
      dropped: goals.length - counted.length,
      open: goals.filter((goal) => goal.status === 'open').length,
      achievedShare: counted.length === 0 ? null : achieved / counted.length,
      runsWithGoals: goalsByRun.size,
      measuredRuns,
      coverage:
        measuredRuns === 0
          ? null
          : [...goalsByRun.keys()].filter((runId) => measured.has(runId))
              .length / measuredRuns,
    },
    outcomes,
    handOffs:
      measuredRuns === 0
        ? null
        : stages.filter((row) => row.action === 'handoff').length,
    ...toolFigures(input.toolCalls.filter((row) => runIds.has(row.runId))),
    stages: stageFigures(stages),
    calls: callFigures(input.calls.filter((row) => runIds.has(row.runId))),
  };
}

/** Per tool and per MCP server, most called first. */
export function toolFigures(rows: readonly ToolCallLedgerRow[]): {
  tools: ToolUseWire[];
  mcpServers: McpServerUseWire[];
} {
  const tools = new Map<
    string,
    ToolUseWire & { timed: number; totalMs: number }
  >();
  const servers = new Map<string, McpServerUseWire & { names: Set<string> }>();
  for (const row of rows) {
    const key = `${row.mcpServer ?? ''}\u0000${row.tool}`;
    const tool = tools.get(key) ?? {
      tool: row.tool,
      mcpServer: row.mcpServer,
      calls: 0,
      errors: 0,
      avgMs: null,
      timed: 0,
      totalMs: 0,
    };
    tool.calls += 1;
    tool.errors += row.ok ? 0 : 1;
    if (row.durationMs !== null) {
      tool.timed += 1;
      tool.totalMs += row.durationMs;
    }
    tools.set(key, tool);
    if (row.mcpServer !== null) {
      const server = servers.get(row.mcpServer) ?? {
        server: row.mcpServer,
        calls: 0,
        errors: 0,
        tools: 0,
        names: new Set<string>(),
      };
      server.calls += 1;
      server.errors += row.ok ? 0 : 1;
      server.names.add(row.tool);
      servers.set(row.mcpServer, server);
    }
  }
  return {
    tools: [...tools.values()]
      .map(({ timed, totalMs, ...tool }) => ({
        ...tool,
        avgMs: timed === 0 ? null : Math.round(totalMs / timed),
      }))
      .sort(
        (a, b) =>
          b.calls - a.calls ||
          (a.mcpServer ?? '').localeCompare(b.mcpServer ?? '') ||
          a.tool.localeCompare(b.tool),
      ),
    mcpServers: [...servers.values()]
      .map(({ names, ...server }) => ({ ...server, tools: names.size }))
      .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)),
  };
}

function stageFigures(rows: readonly StageLedgerRow[]): StageFiguresWire[] {
  const stages = new Map<
    string,
    StageFiguresWire & { timed: number; totalMs: number }
  >();
  for (const row of rows) {
    if (row.action === 'handoff') {
      continue;
    }
    const stage = stages.get(row.stageId) ?? {
      stageId: row.stageId,
      completed: 0,
      skipped: 0,
      reopened: 0,
      avgMs: null,
      timed: 0,
      totalMs: 0,
    };
    if (row.action === 'complete') {
      stage.completed += 1;
      if (row.durationMs !== null) {
        stage.timed += 1;
        stage.totalMs += row.durationMs;
      }
    } else if (row.action === 'skip') {
      stage.skipped += 1;
    } else if (row.action === 'reopen') {
      stage.reopened += 1;
    }
    stages.set(row.stageId, stage);
  }
  return [...stages.values()].map(({ timed, totalMs, ...stage }) => ({
    ...stage,
    avgMs: timed === 0 ? null : Math.round(totalMs / timed),
  }));
}

function callFigures(rows: readonly CallLedgerRow[]): MemberCallWire[] {
  const pairs = new Map<
    string,
    MemberCallWire & { timed: number; totalMs: number }
  >();
  for (const row of rows) {
    const key = `${row.caller}\u0000${row.callee}`;
    const pair = pairs.get(key) ?? {
      caller: row.caller,
      callee: row.callee,
      calls: 0,
      failed: 0,
      turns: 0,
      costUsd: null,
      avgMs: null,
      timed: 0,
      totalMs: 0,
    };
    pair.calls += 1;
    pair.failed += row.ok ? 0 : 1;
    pair.turns += row.turns ?? 0;
    if (row.costUsd !== null) {
      pair.costUsd = (pair.costUsd ?? 0) + row.costUsd;
    }
    if (row.durationMs !== null) {
      pair.timed += 1;
      pair.totalMs += row.durationMs;
    }
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .map(({ timed, totalMs, ...pair }) => ({
      ...pair,
      avgMs: timed === 0 ? null : Math.round(totalMs / timed),
    }))
    .sort(
      (a, b) =>
        b.calls - a.calls ||
        a.caller.localeCompare(b.caller) ||
        a.callee.localeCompare(b.callee),
    );
}
