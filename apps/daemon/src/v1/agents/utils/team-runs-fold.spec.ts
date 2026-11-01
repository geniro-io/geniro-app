import { describe, expect, it } from 'vitest';

import { TeamSchema } from '../../teams/teams.types';
import { teamVersionOf } from '../../teams/utils/team-version';
import type { FoldedRun } from '../chat.types';
import {
  callFigures,
  configuredModels,
  modelFigures,
  nodeFigures,
  runFigures,
  runNodeFigures,
  snapshotVersion,
  teamCardStats,
  versionFigures,
} from './team-runs-fold';

type Turn = FoldedRun['turns'][number];
type Lane = FoldedRun['lanes'][number];

let clock = 0;

function turn(patch: Partial<Turn>): Turn {
  clock += 1_000;
  return {
    nodeId: 'dev',
    startedAt: new Date(clock).toISOString(),
    model: 'sonnet',
    member: null,
    outcome: 'completed',
    durationMs: 1_000,
    toolCalls: 2,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.5,
    contextTokens: null,
    timingSource: 'cli',
    ...patch,
  };
}

function lane(patch: Partial<Lane>): Lane {
  return {
    nodeId: 'dev',
    agentKind: 'claude',
    turns: 1,
    workedMs: 1_000,
    toolCalls: 2,
    costUsd: 0.5,
    ...patch,
  };
}

function run(
  runId: string,
  turns: Turn[],
  patch: Partial<FoldedRun> = {},
): FoldedRun {
  return {
    runId,
    turns,
    lanes: [lane({}), lane({ nodeId: 'qa', agentKind: 'cursor-agent' })],
    calls: [],
    wallWorkedMs: new Map(),
    callWorkedMs: new Map(),
    costUsd: 9,
    version: 'v-a',
    nodeModels: new Map(),
    pooledNodes: new Set(),
    timeline: {
      wallMs: 60_000,
      activeMs: 50_000,
      waitingOnUserMs: 5_000,
      criticalPathMs: 40_000,
      criticalPath: [],
      nodes: [],
      tools: [],
    },
    ...patch,
  };
}

type Tool = FoldedRun['timeline']['tools'][number];

function tool(patch: Partial<Tool>): Tool {
  return {
    seq: 1,
    resultSeq: 2,
    nodeId: 'dev',
    name: 'Bash',
    startMs: 0,
    durationMs: 1,
    open: false,
    delegate: false,
    failed: false,
    ...patch,
  };
}

type NodeTime = FoldedRun['timeline']['nodes'][number];

function nodeTime(patch: Partial<NodeTime>): NodeTime {
  return {
    nodeId: 'dev',
    inTurnsMs: 0,
    waitingOnCalleeMs: 0,
    waitingOnUserMs: 0,
    busyMs: 0,
    turns: 0,
    toolCalls: 0,
    delegateToolCalls: 0,
    toolMs: 0,
    delegateToolMs: 0,
    ...patch,
  };
}

type Call = FoldedRun['calls'][number];

function call(patch: Partial<Call>): Call {
  return {
    callerNodeId: 'lead',
    calleeNodeId: 'dev',
    status: 'ok',
    running: false,
    durationMs: 1_000,
    seq: 1,
    ...patch,
  };
}

describe('modelFigures', () => {
  it('sums every turn of every run per node and model', () => {
    // Many turns per run, so a fold over any window of them would differ.
    const first = run('r1', [
      ...Array.from({ length: 30 }, () => turn({})),
      turn({ nodeId: 'qa', model: 'gpt-5', durationMs: 4_000 }),
    ]);
    const second = run('r2', [
      turn({ model: 'opus', costUsd: 2, durationMs: 3_000 }),
      turn({ nodeId: 'qa', model: 'gpt-5', outcome: 'completed' }),
    ]);

    const rows = modelFigures([first, second]);

    expect(rows.map((row) => [row.node, row.model])).toEqual([
      ['dev', 'sonnet'],
      ['dev', 'opus'],
      ['qa', 'gpt-5'],
    ]);
    expect(rows[0]).toMatchObject({
      runs: 1,
      turns: 30,
      timedTurns: 30,
      durationMs: 30_000,
      avgTurnMs: 1_000,
      toolCalls: 60,
      inputTokens: 3_000,
      outputTokens: 300,
      costUsd: 15,
      pricedTurns: 30,
      costPerTurnUsd: 0.5,
    });
    expect(rows[2]).toMatchObject({ runs: 2, turns: 2, avgTurnMs: 2_500 });
  });

  it('counts a turn that reported no model against the model its node last reported', () => {
    const rows = modelFigures([
      run('r1', [
        turn({ model: 'claude-opus-4' }),
        turn({ outcome: 'failed', model: null, costUsd: null }),
        turn({ outcome: 'cancelled', model: null, costUsd: null }),
      ]),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        node: 'dev',
        model: 'claude-opus-4',
        modelSource: 'reported',
        turns: 3,
        failedTurns: 1,
        cancelledTurns: 1,
        pricedTurns: 1,
      }),
    ]);
  });

  // A pool hands on when a member fails before reporting, so the next model
  // reported is another member's: such a failure is never filed under it.
  it('files a turn that ended before its node reported any model under the configured model, marked so', () => {
    const rows = modelFigures([
      run(
        'r1',
        [
          turn({ outcome: 'failed', model: null, costUsd: null }),
          turn({ model: 'gpt-5' }),
          turn({ nodeId: 'qa', outcome: 'running', model: null }),
        ],
        {
          nodeModels: new Map([
            ['dev', 'opus'],
            ['qa', null],
          ]),
        },
      ),
    ]);

    expect(
      rows.map((row) => [row.node, row.model, row.modelSource, row.turns]),
    ).toEqual([
      ['dev', 'opus', 'configured', 1],
      ['dev', 'gpt-5', 'reported', 1],
      ['qa', null, 'configured', 1],
    ]);
    expect(rows[1]!.failedTurns).toBe(0);
  });

  // A pool hands a node from member to member between turns, and a turn
  // names no member: a model guessed for it could be another member's.
  it("leaves a pooled node's turn that reported no model unattributed", () => {
    const rows = modelFigures([
      run(
        'r1',
        [
          turn({ model: 'claude-opus-4' }),
          turn({ outcome: 'failed', model: null, costUsd: null }),
        ],
        {
          pooledNodes: new Set(['dev']),
          nodeModels: new Map([['dev', 'opus']]),
        },
      ),
    ]);

    expect(
      rows.map((row) => [row.model, row.modelSource, row.failedTurns]),
    ).toEqual([
      ['claude-opus-4', 'reported', 0],
      [null, 'unreported', 1],
    ]);
  });

  // A pool hands on when a member fails, so the model reported before or
  // after may be another member's: each member is followed on its own.
  it("follows a pooled node's members apart, by the member each turn's row names", () => {
    const claude = { agentKind: 'claude' as const, model: 'opus' };
    const codex = { agentKind: 'codex' as const, model: null };
    const rows = modelFigures([
      run(
        'r1',
        [
          // Member 1 fails before reporting: its configured model, its CLI.
          turn({ outcome: 'failed', model: null, member: claude }),
          // Handed on to member 2, which reports.
          turn({ model: 'gpt-5-codex', member: codex }),
          // Member 1 again, having reported once since.
          turn({ model: 'claude-opus-4', member: claude }),
          turn({ outcome: 'cancelled', model: null, member: claude }),
        ],
        { pooledNodes: new Set(['dev']) },
      ),
    ]);

    expect(
      rows.map((row) => [
        row.agent,
        row.model,
        row.modelSource,
        row.turns,
        row.failedTurns,
        row.cancelledTurns,
      ]),
    ).toEqual([
      ['claude', 'claude-opus-4', 'reported', 2, 0, 1],
      ['claude', 'opus', 'configured', 1, 1, 0],
      ['codex', 'gpt-5-codex', 'reported', 1, 0, 0],
    ]);
  });

  // cursor reports no timing: its completed turn is drawn from the lane's
  // previous row so the lane shows, a span of milliseconds.
  it('counts a completed turn its CLI did not time, but times only the measured ones', () => {
    const [row] = modelFigures([
      run('r1', [
        turn({ durationMs: 4_000 }),
        turn({ timingSource: 'derived', durationMs: 2 }),
        // Bracketed by status rows: a measured span.
        turn({ timingSource: 'derived', outcome: 'failed', durationMs: 6_000 }),
      ]),
    ]);
    const [untimed] = modelFigures([
      run('r2', [turn({ timingSource: 'derived', durationMs: 2 })]),
    ]);

    expect(row).toMatchObject({
      turns: 3,
      timedTurns: 2,
      durationMs: 10_000,
      avgTurnMs: 5_000,
    });
    expect(untimed).toMatchObject({ turns: 1, timedTurns: 0, avgTurnMs: null });
  });

  it('keeps a figure no turn reported as null, never zero', () => {
    const [row] = modelFigures([
      run('r1', [turn({ costUsd: null, inputTokens: null })]),
    ]);

    expect(row).toMatchObject({
      costUsd: null,
      inputTokens: null,
      pricedTurns: 0,
      costPerTurnUsd: null,
    });
  });
});

describe('nodeFigures', () => {
  it("sums each node's lanes over the runs — its own turn count and bill, a polled one included", () => {
    const rows = nodeFigures([
      run('r1', [turn({ outcome: 'failed' })], {
        lanes: [
          lane({ turns: 7, costUsd: 3, workedMs: 9_000 }),
          // A polled-spend CLI prices no turn; its lane carries the bill.
          lane({
            nodeId: 'qa',
            agentKind: 'cursor-agent',
            costUsd: 4,
            workedMs: null,
          }),
        ],
        // Its turns are timed by the wall clock alone.
        wallWorkedMs: new Map([['qa', 7_000]]),
      }),
      run('r2', [], {
        lanes: [lane({ turns: 5, costUsd: 1, workedMs: null })],
      }),
    ]);

    expect(rows).toEqual([
      {
        node: 'dev',
        agent: 'claude',
        runs: 2,
        turns: 12,
        failedTurns: 1,
        cancelledTurns: 0,
        workedMs: 9_000,
        toolCalls: 4,
        costUsd: 4,
        costPerRunUsd: 2,
      },
      expect.objectContaining({
        node: 'qa',
        agent: 'cursor-agent',
        runs: 1,
        workedMs: 7_000,
        costUsd: 4,
      }),
    ]);
  });

  it('prices a node per run over the runs that reported its cost, never the unpriced ones as free', () => {
    const [dev] = nodeFigures([
      run('r1', [], { lanes: [lane({ costUsd: 6 })] }),
      run('r2', [], { lanes: [lane({ costUsd: null })] }),
    ]);

    expect(dev).toMatchObject({ runs: 2, costUsd: 6, costPerRunUsd: 6 });
  });
});

describe('runFigures', () => {
  it("states a run's turns as its lanes counted them and its whole bill", () => {
    expect(
      runFigures(
        run(
          'r1',
          [
            turn({}),
            turn({ outcome: 'failed', costUsd: 1 }),
            turn({ outcome: 'cancelled', costUsd: null }),
          ],
          {
            lanes: [lane({ turns: 4 }), lane({ nodeId: 'qa', turns: 2 })],
            calls: [call({}), call({ status: 'failed' })],
            timeline: {
              wallMs: 60_000,
              activeMs: 50_000,
              waitingOnUserMs: 5_000,
              criticalPathMs: 42_000,
              criticalPath: [],
              nodes: [],
              tools: [tool({ failed: true })],
            },
          },
        ),
      ),
    ).toEqual({
      wallMs: 60_000,
      activeMs: 50_000,
      waitingOnUserMs: 5_000,
      criticalPathMs: 42_000,
      turns: 6,
      failedTurns: 1,
      cancelledTurns: 1,
      failedToolCalls: 1,
      calls: 2,
      costUsd: 9,
    });
  });
});

describe('runNodeFigures', () => {
  it("states each node's own share of one run: its time working and blocked, its critical path, tools and bill", () => {
    const rows = runNodeFigures(
      run(
        'r1',
        [
          // More turns than any page of rows holds.
          ...Array.from({ length: 45 }, () => turn({ contextTokens: 10_000 })),
          turn({ outcome: 'failed', contextTokens: 80_000 }),
          turn({ nodeId: 'qa', outcome: 'cancelled' }),
        ],
        {
          lanes: [
            lane({ turns: 46, workedMs: 300_000, toolCalls: 90, costUsd: 7 }),
            lane({
              nodeId: 'qa',
              agentKind: 'cursor-agent',
              workedMs: null,
              costUsd: null,
            }),
          ],
          timeline: {
            wallMs: 600_000,
            activeMs: 500_000,
            waitingOnUserMs: 30_000,
            criticalPathMs: 400_000,
            criticalPath: [
              { kind: 'work', nodeId: 'dev', startMs: 0, durationMs: 250_000 },
              {
                kind: 'waiting_on_user',
                nodeId: 'dev',
                startMs: 250_000,
                durationMs: 30_000,
              },
              {
                kind: 'work',
                nodeId: 'qa',
                startMs: 280_000,
                durationMs: 20_000,
              },
              {
                kind: 'work',
                nodeId: 'dev',
                startMs: 300_000,
                durationMs: 100_000,
              },
            ],
            nodes: [
              nodeTime({
                inTurnsMs: 420_000,
                busyMs: 350_000,
                waitingOnCalleeMs: 40_000,
                waitingOnUserMs: 30_000,
              }),
            ],
            tools: [
              tool({ failed: true }),
              tool({ failed: true, delegate: true }),
              tool({ nodeId: 'qa', failed: true }),
              tool({}),
            ],
          },
        },
      ),
    );

    expect(rows).toEqual([
      {
        node: 'dev',
        agent: 'claude',
        turns: 46,
        failedTurns: 1,
        cancelledTurns: 0,
        workedMs: 300_000,
        busyMs: 350_000,
        waitingOnCalleeMs: 40_000,
        waitingOnUserMs: 30_000,
        criticalPathMs: 350_000,
        toolCalls: 90,
        failedToolCalls: 2,
        costUsd: 7,
        maxContextTokens: 80_000,
      },
      {
        node: 'qa',
        agent: 'cursor-agent',
        turns: 1,
        failedTurns: 0,
        cancelledTurns: 1,
        workedMs: null,
        busyMs: null,
        waitingOnCalleeMs: null,
        waitingOnUserMs: null,
        criticalPathMs: 20_000,
        toolCalls: 2,
        failedToolCalls: 1,
        costUsd: null,
        maxContextTokens: null,
      },
    ]);
  });

  // cursor reports no timing: the wall clock's ledger times its turns, and
  // the waterfall draws each completed one from its lane's previous row.
  it("times a node its CLI did not time by the wall clock, and leaves the drawn spans' figures unmeasured", () => {
    const [qa] = runNodeFigures(
      run(
        'r1',
        [
          turn({ nodeId: 'qa', timingSource: 'derived', durationMs: 2 }),
          turn({
            nodeId: 'qa',
            timingSource: 'derived',
            outcome: 'failed',
            durationMs: 9_000,
          }),
        ],
        {
          lanes: [
            lane({
              nodeId: 'qa',
              agentKind: 'cursor-agent',
              turns: 2,
              workedMs: null,
            }),
          ],
          wallWorkedMs: new Map([['qa', 5_249_368]]),
          timeline: {
            wallMs: 600_000,
            activeMs: 500_000,
            waitingOnUserMs: 0,
            criticalPathMs: 9_002,
            criticalPath: [
              { kind: 'work', nodeId: 'qa', startMs: 0, durationMs: 9_002 },
            ],
            nodes: [
              nodeTime({ nodeId: 'qa', inTurnsMs: 9_002, busyMs: 9_002 }),
            ],
            tools: [],
          },
        },
      ),
    );

    expect(qa).toMatchObject({
      node: 'qa',
      turns: 2,
      workedMs: 5_249_368,
      busyMs: null,
      waitingOnCalleeMs: null,
      waitingOnUserMs: null,
      criticalPathMs: null,
    });
  });
});

describe('callFigures', () => {
  it('sums every call on each caller→callee edge over the runs, longest total first', () => {
    const rows = callFigures([
      run('r1', [], {
        calls: [
          ...Array.from({ length: 40 }, () => call({ durationMs: 2_000 })),
          call({ status: 'failed', durationMs: 9_000 }),
          call({ calleeNodeId: 'qa', durationMs: 500 }),
        ],
      }),
      run('r2', [], {
        calls: [call({ status: null, running: true, durationMs: 4_000 })],
      }),
    ]);

    expect(rows).toEqual([
      {
        caller: 'lead',
        callee: 'dev',
        runs: 2,
        calls: 42,
        failedCalls: 1,
        runningCalls: 1,
        totalMs: 93_000,
        avgMs: 2_214,
        maxMs: 9_000,
        workedMs: null,
      },
      {
        caller: 'lead',
        callee: 'qa',
        runs: 1,
        calls: 1,
        failedCalls: 0,
        runningCalls: 0,
        totalMs: 500,
        avgMs: 500,
        maxMs: 500,
        workedMs: null,
      },
    ]);
  });

  it('sums how long the callees worked inside each edge’s calls, matched by their start row', () => {
    const rows = callFigures([
      run('r1', [], {
        calls: [
          call({ seq: 10, durationMs: 60_000 }),
          call({ seq: 20, durationMs: 30_000 }),
          call({ seq: 30, calleeNodeId: 'qa', durationMs: 5_000 }),
        ],
        callWorkedMs: new Map([
          [10, 40_000],
          [20, 12_000],
        ]),
      }),
      run('r2', [], {
        calls: [call({ seq: 10, durationMs: 9_000 })],
        callWorkedMs: new Map([[10, 7_000]]),
      }),
    ]);

    expect(
      rows.map(({ callee, totalMs, workedMs }) => ({
        callee,
        totalMs,
        workedMs,
      })),
    ).toEqual([
      { callee: 'dev', totalMs: 99_000, workedMs: 59_000 },
      { callee: 'qa', totalMs: 5_000, workedMs: null },
    ]);
  });
});

describe('configuredModels', () => {
  it("reads each agent's model and pool from the run's own frozen copy", () => {
    const snapshot = JSON.stringify({
      name: 'Team',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        {
          id: 'dev',
          kind: 'agent',
          agent: 'claude',
          approval: 'auto',
          model: 'opus',
        },
        {
          id: 'qa',
          kind: 'agent',
          agent: 'codex',
          approval: 'auto',
          pool: [{ agent: 'claude', model: 'sonnet' }],
        },
      ],
      edges: [],
    });

    const { nodeModels, pooledNodes } = configuredModels(snapshot);

    expect([...nodeModels]).toEqual([
      ['dev', 'opus'],
      ['qa', null],
    ]);
    expect([...pooledNodes]).toEqual(['qa']);
  });

  it('reads an unreadable or missing copy as nothing configured', () => {
    expect(configuredModels(null).nodeModels.size).toBe(0);
    expect(configuredModels('{nope').pooledNodes.size).toBe(0);
  });
});

describe('snapshotVersion', () => {
  it('is the graph version the team ledger stamps the run with', () => {
    const team = {
      name: 'Team',
      nodes: [{ id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' }],
      edges: [],
    } as const;
    const renamed = { ...team, name: 'Renamed team' };
    const changed = {
      ...team,
      nodes: [{ ...team.nodes[0], model: 'opus' }],
    };

    const version = snapshotVersion(JSON.stringify(team));

    expect(version).toBe(teamVersionOf(TeamSchema.parse(team)));
    expect(snapshotVersion(JSON.stringify(renamed))).toBe(version);
    expect(snapshotVersion(JSON.stringify(changed))).not.toBe(version);
  });

  it('is null for a run that kept no copy it can read', () => {
    expect(snapshotVersion(null)).toBeNull();
    expect(snapshotVersion('{nope')).toBeNull();
  });
});

describe('versionFigures', () => {
  const index = {
    current: 'v-b',
    numbers: new Map([
      ['v-a', 1],
      ['v-b', 2],
    ]),
  };

  function timed(wallMs: number, costUsd: number | null): Partial<FoldedRun> {
    return {
      costUsd,
      timeline: {
        wallMs,
        activeMs: wallMs / 2,
        waitingOnUserMs: 0,
        criticalPathMs: wallMs / 4,
        criticalPath: [],
        nodes: [],
        tools: [tool({ failed: true })],
      },
    };
  }

  it('groups the runs by the version they ran and averages each group per run, newest version first', () => {
    const figures = versionFigures(
      [
        run('old-1', [turn({ outcome: 'failed' }), turn({})], {
          version: 'v-a',
          ...timed(100_000, 2),
        }),
        run('old-2', [turn({})], { version: 'v-a', ...timed(300_000, 4) }),
        run('new-1', [turn({})], { version: 'v-b', ...timed(40_000, 1) }),
        run('new-2', [turn({})], { version: 'v-b', ...timed(60_000, null) }),
        run('new-3', [turn({})], { version: 'v-b', ...timed(50_000, 2) }),
      ],
      index,
    );

    expect(figures.map((group) => [group.number, group.runIds])).toEqual([
      [2, ['new-1', 'new-2', 'new-3']],
      [1, ['old-1', 'old-2']],
    ]);
    const [current, earlier] = figures;
    expect(current).toMatchObject({
      version: 'v-b',
      current: true,
      avgWallMs: 50_000,
      medianWallMs: 50_000,
      avgActiveMs: 25_000,
      avgCriticalPathMs: 12_500,
      failedTurns: 0,
      failedToolCalls: 3,
      pricedRuns: 2,
      avgCostUsd: 1.5,
    });
    expect(earlier).toMatchObject({
      version: 'v-a',
      current: false,
      avgWallMs: 200_000,
      medianWallMs: 200_000,
      failedTurns: 1,
      pricedRuns: 2,
      avgCostUsd: 3,
    });
  });

  it('names a version no run or restore recorded by its hash alone, and a run with no copy as its own group', () => {
    const figures = versionFigures(
      [
        run('edited', [turn({})], { version: 'v-c' }),
        run('no-copy', [turn({})], { version: null }),
      ],
      index,
    );

    expect(
      figures.map(({ version, number, current }) => ({
        version,
        number,
        current,
      })),
    ).toEqual(
      expect.arrayContaining([
        { version: 'v-c', number: null, current: false },
        { version: null, number: null, current: false },
      ]),
    );
  });

  it('names every version by hash alone when no index could be read', () => {
    expect(
      versionFigures([run('one', [turn({})], { version: 'v-b' })], null)[0],
    ).toMatchObject({ version: 'v-b', number: null, current: false });
  });
});

describe('teamCardStats', () => {
  const index = {
    current: 'v-b',
    numbers: new Map([
      ['v-a', 1],
      ['v-b', 2],
    ]),
  };

  const newest = run(
    'r2',
    [
      ...Array.from({ length: 45 }, () => turn({})),
      turn({ outcome: 'failed', model: 'opus' }),
      turn({ nodeId: 'qa', model: 'gpt' }),
    ],
    {
      version: 'v-b',
      costUsd: 12,
      lanes: [
        lane({ turns: 46, workedMs: 600_000, toolCalls: 90, costUsd: 11 }),
        lane({
          nodeId: 'qa',
          agentKind: 'cursor-agent',
          workedMs: 60_000,
          costUsd: 1,
        }),
      ],
      calls: Array.from({ length: 7 }, (_, at) =>
        call({
          calleeNodeId: `n${at}`,
          durationMs: (at + 1) * 1_000,
          seq: at + 1,
        }),
      ),
      callWorkedMs: new Map([[7, 4_400.4]]),
      timeline: {
        wallMs: 900_000,
        activeMs: 700_000,
        waitingOnUserMs: 60_000,
        criticalPathMs: 800_000,
        criticalPath: [
          { kind: 'work', nodeId: 'dev', startMs: 0, durationMs: 500_000 },
        ],
        nodes: [
          nodeTime({ busyMs: 500_000, waitingOnCalleeMs: 100_000 }),
          nodeTime({ nodeId: 'qa', busyMs: 60_000 }),
        ],
        tools: [tool({ failed: true })],
      },
    },
  );
  const older = run('r1', [turn({})], {
    costUsd: null,
    lanes: [lane({ workedMs: 300_000, costUsd: null })],
  });

  it("states the runs' averages and totals and each run with its version, over every turn and call", () => {
    const stats = teamCardStats(
      [
        { title: 'Newest', createdAt: new Date(2_000), folded: newest },
        { title: null, createdAt: new Date(1_000), folded: older },
      ],
      index,
    );

    expect(stats).toMatchObject({
      runs: 2,
      perRun: {
        wallMs: 480_000,
        activeMs: 375_000,
        waitingOnUserMs: 32_500,
        criticalPathMs: 420_000,
        turns: 24,
        calls: 3.5,
        costUsd: 12,
        pricedRuns: 1,
      },
      totals: {
        wallMs: 960_000,
        activeMs: 750_000,
        turns: 48,
        failedTurns: 1,
        cancelledTurns: 0,
        toolCalls: 94,
        failedToolCalls: 1,
        calls: 7,
        costUsd: 12,
      },
      runList: [
        {
          runId: 'r2',
          title: 'Newest',
          createdAt: new Date(2_000).toISOString(),
          version: 2,
          current: true,
          wallMs: 900_000,
          activeMs: 700_000,
          waitingOnUserMs: 60_000,
          turns: 47,
          failedTurns: 1,
          costUsd: 12,
        },
        {
          runId: 'r1',
          title: null,
          version: 1,
          current: false,
          turns: 1,
          failedTurns: 0,
          costUsd: null,
        },
      ],
    });
    expect(stats?.callEdges).toBe(7);
    expect(
      stats?.calls.map((edge) => [edge.callee, edge.totalMs, edge.workedMs]),
    ).toEqual([
      ['n6', 7_000, 4_400],
      ['n5', 6_000, null],
      ['n4', 5_000, null],
      ['n3', 4_000, null],
      ['n2', 3_000, null],
    ]);
  });

  it('sums each agent over the runs, longest working first, with its models, each per-run figure over the runs that measured it', () => {
    const stats = teamCardStats(
      [
        { title: null, createdAt: new Date(2_000), folded: newest },
        { title: null, createdAt: new Date(1_000), folded: older },
      ],
      null,
    );

    expect(stats?.agents).toEqual([
      {
        node: 'dev',
        agent: 'claude',
        runs: 2,
        turns: 47,
        failedTurns: 1,
        cancelledTurns: 0,
        workedMs: 900_000,
        workedPerRunMs: 450_000,
        waitingOnCalleePerRunMs: 100_000,
        criticalPathPerRunMs: 250_000,
        toolCalls: 92,
        failedToolCalls: 1,
        costUsd: 11,
        costPerRunUsd: 11,
        maxContextTokens: null,
        models: [
          expect.objectContaining({
            model: 'sonnet',
            turns: 46,
            failedTurns: 0,
            avgTurnMs: 1_000,
            costPerTurnUsd: 0.5,
          }),
          expect.objectContaining({
            model: 'opus',
            turns: 1,
            failedTurns: 1,
          }),
        ],
      },
      expect.objectContaining({
        node: 'qa',
        agent: 'cursor-agent',
        runs: 1,
        workedMs: 60_000,
        workedPerRunMs: 60_000,
        costPerRunUsd: 1,
        models: [expect.objectContaining({ model: 'gpt', turns: 1 })],
      }),
    ]);
    expect(stats?.runList.map((entry) => entry.version)).toEqual([null, null]);
  });

  it('is null when no run could be folded', () => {
    expect(teamCardStats([], index)).toBeNull();
  });
});
