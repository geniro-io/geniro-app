import { describe, expect, it } from 'vitest';

import type { FoldedRun } from '../chat.types';
import {
  configuredModels,
  modelFigures,
  nodeFigures,
  runFigures,
} from './workflow-runs-fold';

type Turn = FoldedRun['turns'][number];
type Lane = FoldedRun['lanes'][number];

let clock = 0;

function turn(patch: Partial<Turn>): Turn {
  clock += 1_000;
  return {
    nodeId: 'dev',
    startedAt: new Date(clock).toISOString(),
    model: 'sonnet',
    outcome: 'completed',
    durationMs: 1_000,
    toolCalls: 2,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.5,
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
    costUsd: 9,
    nodeModels: new Map(),
    pooledNodes: new Set(),
    timeline: {
      wallMs: 60_000,
      activeMs: 50_000,
      waitingOnUserMs: 5_000,
      tools: [],
    },
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
          lane({ nodeId: 'qa', agentKind: 'cursor-agent', costUsd: 4 }),
        ],
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
        costUsd: 4,
      }),
    ]);
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
            timeline: {
              wallMs: 60_000,
              activeMs: 50_000,
              waitingOnUserMs: 5_000,
              tools: [
                {
                  seq: 1,
                  resultSeq: 2,
                  nodeId: 'dev',
                  name: 'Bash',
                  startMs: 0,
                  durationMs: 1,
                  open: false,
                  delegate: false,
                  failed: true,
                },
              ],
            },
          },
        ),
      ),
    ).toEqual({
      wallMs: 60_000,
      activeMs: 50_000,
      waitingOnUserMs: 5_000,
      turns: 6,
      failedTurns: 1,
      cancelledTurns: 1,
      failedToolCalls: 1,
      costUsd: 9,
    });
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
