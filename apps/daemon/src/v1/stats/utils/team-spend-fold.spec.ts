import { describe, expect, it } from 'vitest';

import type { ModelPriceRates } from '../../agents/utils/model-prices';
import { POLLED_SPEND_SEQ, type ThreadLedgerRow } from '../stats.types';
import {
  CACHE_HEAVY_WRITE_TOKENS,
  foldTeamSpend,
  SPEND_LARGEST_WRITES,
  spendFiguresOf,
  type SpendLedgerRow,
} from './team-spend-fold';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const DAY_MS = 86_400_000;
const RATES: ModelPriceRates = {
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite: 8,
};
const ratesOf = () => RATES;

function row(
  overrides: Partial<SpendLedgerRow> & Pick<SpendLedgerRow, 'runId'>,
): SpendLedgerRow {
  return {
    seq: 1,
    memberId: 'dev',
    agentKind: 'claude',
    model: 'opus',
    cwd: null,
    occurredAt: NOW,
    costUsd: null,
    estimatedCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...overrides,
  };
}

function thread(runId: string, occurredAt: Date = NOW): ThreadLedgerRow {
  return {
    runId,
    occurredAt,
    slug: 'dev-team',
    version: null,
    inferred: null,
  };
}

const placeOf = (cwd: string | null) =>
  cwd === null
    ? { project: null, folder: null }
    : { project: `project-${cwd}`, folder: cwd };

function fold(
  overrides: Partial<Parameters<typeof foldTeamSpend>[0]>,
): ReturnType<typeof foldTeamSpend> {
  return foldTeamSpend({
    slug: 'dev-team',
    threads: [],
    rows: [],
    analysedRunIds: [],
    now: NOW,
    ratesOf,
    placeOf,
    ...overrides,
  });
}

describe('spendFiguresOf — a turn’s bill by token class', () => {
  it('splits a bill five times its list price across the classes in proportion to their list share', () => {
    const turn = row({
      runId: 'run-a',
      costUsd: 35,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 100_000,
    });

    const figures = spendFiguresOf([turn], ratesOf);

    expect(figures.costUsd).toBe(35);
    expect(figures.inputUsd).toBe(20);
    expect(figures.outputUsd).toBe(10);
    expect(figures.cacheReadUsd).toBe(1);
    expect(figures.cacheWriteUsd).toBe(4);
    expect(figures.notSplitUsd).toBe(0);
    expect(
      (figures.inputUsd ?? 0) +
        (figures.outputUsd ?? 0) +
        (figures.cacheReadUsd ?? 0) +
        (figures.cacheWriteUsd ?? 0),
    ).toBe(35);
  });

  it('splits a bill below its list price the same way, so the parts still sum to the bill', () => {
    const turn = row({
      runId: 'run-a',
      costUsd: 3.5,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 100_000,
    });

    const figures = spendFiguresOf([turn], ratesOf);

    expect(figures.inputUsd).toBe(2);
    expect(figures.outputUsd).toBe(1);
    expect(figures.cacheReadUsd).toBe(0.1);
    expect(figures.cacheWriteUsd).toBe(0.4);
    expect(figures.notSplitUsd).toBe(0);
  });

  it('puts the whole bill of a model with no list price into notSplitUsd, still counting its tokens', () => {
    const turn = row({
      runId: 'run-a',
      model: 'unlisted',
      costUsd: 5,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 400,
    });

    const figures = spendFiguresOf([turn], () => null);

    expect(figures.costUsd).toBe(5);
    expect(figures.notSplitUsd).toBe(5);
    expect(figures.inputUsd).toBe(0);
    expect(figures.outputUsd).toBe(0);
    expect(figures.cacheReadUsd).toBe(0);
    expect(figures.cacheWriteUsd).toBe(0);
    expect(figures.inputTokens).toBe(1_000);
    expect(figures.outputTokens).toBe(200);
    expect(figures.cacheReadTokens).toBe(300);
    expect(figures.cacheWriteTokens).toBe(400);
  });

  it('counts a polled bill as money with no turn behind it: notSplitUsd, turns unchanged, the run priced', () => {
    const turn = row({ runId: 'run-a', seq: 1, inputTokens: 1_000 });
    const polled = row({
      runId: 'run-a',
      seq: POLLED_SPEND_SEQ,
      costUsd: 6,
    });

    const figures = spendFiguresOf([turn, polled], ratesOf);

    expect(figures.turns).toBe(1);
    expect(figures.runs).toBe(1);
    expect(figures.pricedRuns).toBe(1);
    expect(figures.costUsd).toBe(6);
    expect(figures.notSplitUsd).toBe(6);
    expect(figures.inputUsd).toBe(0);
    expect(figures.inputTokens).toBe(1_000);
  });

  it('leaves a run with a polled bill of zero unpriced', () => {
    const polled = row({
      runId: 'run-a',
      seq: POLLED_SPEND_SEQ,
      costUsd: 0,
    });

    const figures = spendFiguresOf([polled], ratesOf);

    expect(figures.runs).toBe(1);
    expect(figures.pricedRuns).toBe(0);
    expect(figures.costUsd).toBeNull();
    expect(figures.avgCostPerRunUsd).toBeNull();
    expect(figures.notSplitUsd).toBeNull();
  });

  it('answers null, never zero, for money when no row of the set reported a cost, while still counting its turns', () => {
    const figures = spendFiguresOf(
      [
        row({ runId: 'run-a', inputTokens: 1_000 }),
        row({ runId: 'run-b', inputTokens: 2_000 }),
      ],
      ratesOf,
    );

    expect(figures.runs).toBe(2);
    expect(figures.turns).toBe(2);
    expect(figures.pricedRuns).toBe(0);
    expect(figures.costUsd).toBeNull();
    expect(figures.avgCostPerRunUsd).toBeNull();
    expect(figures.estimatedCostUsd).toBeNull();
    expect(figures.inputUsd).toBeNull();
    expect(figures.cacheReadUsd).toBeNull();
    expect(figures.cacheWriteUsd).toBeNull();
    expect(figures.outputUsd).toBeNull();
    expect(figures.notSplitUsd).toBeNull();
    expect(figures.inputTokens).toBe(3_000);
  });

  it('divides the average by the runs that reported a cost, not by every run of the set', () => {
    const figures = spendFiguresOf(
      [
        row({ runId: 'run-priced', costUsd: 6 }),
        row({ runId: 'run-unpriced', costUsd: null }),
      ],
      ratesOf,
    );

    expect(figures.runs).toBe(2);
    expect(figures.pricedRuns).toBe(1);
    expect(figures.costUsd).toBe(6);
    expect(figures.avgCostPerRunUsd).toBe(6);
  });

  it('calls a turn that wrote a heavy cache with less read both a cache miss and a heavy write', () => {
    const figures = spendFiguresOf(
      [
        row({
          runId: 'run-a',
          cacheCreationTokens: CACHE_HEAVY_WRITE_TOKENS,
          cacheReadTokens: 50_000,
        }),
      ],
      ratesOf,
    );

    expect(figures.heavyWriteTurns).toBe(1);
    expect(figures.cacheMissTurns).toBe(1);
  });

  it('calls a heavy cache write that read more than it wrote heavy only, not a miss', () => {
    const figures = spendFiguresOf(
      [
        row({
          runId: 'run-a',
          cacheCreationTokens: CACHE_HEAVY_WRITE_TOKENS,
          cacheReadTokens: 200_000,
        }),
      ],
      ratesOf,
    );

    expect(figures.heavyWriteTurns).toBe(1);
    expect(figures.cacheMissTurns).toBe(0);
  });

  it('calls a write one token under the heavy line neither heavy nor a miss', () => {
    const figures = spendFiguresOf(
      [
        row({
          runId: 'run-a',
          cacheCreationTokens: CACHE_HEAVY_WRITE_TOKENS - 1,
          cacheReadTokens: 0,
        }),
      ],
      ratesOf,
    );

    expect(figures.heavyWriteTurns).toBe(0);
    expect(figures.cacheMissTurns).toBe(0);
  });
});

describe('foldTeamSpend', () => {
  it('counts the whole population: old rows, runs outside the sample and threads without ledger rows, while the windows and the sample set their own scope', () => {
    const old = new Date(NOW.getTime() - 400 * DAY_MS);
    const result = fold({
      threads: [
        thread('run-a'),
        thread('run-b'),
        thread('run-old', old),
        thread('run-ghost'),
      ],
      rows: [
        row({ runId: 'run-a', costUsd: 2 }),
        row({ runId: 'run-b', costUsd: 4 }),
        row({ runId: 'run-old', costUsd: 10, occurredAt: old }),
      ],
      analysedRunIds: ['run-a'],
    });

    expect(result.population.runs).toBe(4);
    expect(result.population.runsWithUsage).toBe(3);

    const [all, last30Days, analysedRuns] = result.windows;
    expect(all).toMatchObject({
      window: 'all',
      runs: 3,
      costUsd: 16,
    });
    expect(last30Days).toMatchObject({
      window: 'last30Days',
      runs: 2,
      costUsd: 6,
    });
    expect(analysedRuns).toMatchObject({
      window: 'analysedRuns',
      runs: 1,
      costUsd: 2,
    });
    expect(all!.avgCostPerRunUsd).toBe(5.33);
    expect(analysedRuns!.avgCostPerRunUsd).toBe(2);
  });

  it('averages the whole population apart from the analysed sample', () => {
    const result = fold({
      threads: [thread('run-a'), thread('run-b')],
      rows: [
        row({ runId: 'run-a', costUsd: 2 }),
        row({ runId: 'run-b', costUsd: 8 }),
      ],
      analysedRunIds: ['run-a'],
    });

    const [all, , analysedRuns] = result.windows;
    expect(all!.avgCostPerRunUsd).toBe(5);
    expect(analysedRuns!.avgCostPerRunUsd).toBe(2);
  });

  it('answers a group whose rows fall outside the last 30 days with a null last30Days', () => {
    const old = new Date(NOW.getTime() - 400 * DAY_MS);
    const result = fold({
      threads: [thread('run-a'), thread('run-old', old)],
      rows: [
        row({ runId: 'run-a', memberId: 'recent', costUsd: 2 }),
        row({
          runId: 'run-old',
          memberId: 'old-member',
          costUsd: 1,
          occurredAt: old,
        }),
      ],
    });

    const oldMember = result.byMember.find(
      (group) => group.member === 'old-member',
    );
    expect(oldMember!.last30Days).toBeNull();
    expect(oldMember!.all.costUsd).toBe(1);
  });

  it('gives every window what it covers and its bounds, the recent window starting thirty days back', () => {
    const result = fold({
      threads: [thread('run-a')],
      rows: [row({ runId: 'run-a', costUsd: 2 })],
      analysedRunIds: ['run-a'],
    });

    expect(result.windows.map((window) => window.window)).toEqual([
      'all',
      'last30Days',
      'analysedRuns',
    ]);
    for (const window of result.windows) {
      expect(window.covers.length).toBeGreaterThan(0);
      expect(window.to).toBe(NOW.toISOString());
    }
    expect(result.windows[0]!.from).toBe(NOW.toISOString());
    expect(result.windows[1]!.from).toBe(
      new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    );
  });

  it('counts every heavy cache write but names only the largest ones, sorted largest first, flagging only rows of analysed runs', () => {
    const rows = Array.from({ length: SPEND_LARGEST_WRITES + 5 }, (_, index) =>
      row({
        runId: index % 2 === 0 ? 'run-analysed' : 'run-other',
        seq: index + 1,
        occurredAt: new Date(NOW.getTime() - index * 1_000),
        cacheCreationTokens: CACHE_HEAVY_WRITE_TOKENS + index * 1_000,
        cacheReadTokens: 0,
        costUsd: 1,
      }),
    );

    const result = fold({
      threads: [thread('run-analysed'), thread('run-other')],
      rows,
      analysedRunIds: ['run-analysed'],
    });

    expect(result.windows[0]!.heavyWriteTurns).toBe(SPEND_LARGEST_WRITES + 5);
    expect(result.largestCacheWrites).toHaveLength(SPEND_LARGEST_WRITES);
    expect(
      result.largestCacheWrites.map((write) => write.cacheWriteTokens),
    ).toEqual(
      Array.from(
        { length: SPEND_LARGEST_WRITES },
        (_, index) =>
          CACHE_HEAVY_WRITE_TOKENS + (SPEND_LARGEST_WRITES + 4 - index) * 1_000,
      ),
    );
    for (const write of result.largestCacheWrites) {
      expect(write.analysed).toBe(write.runId === 'run-analysed');
    }
    expect(result.largestCacheWrites.some((write) => write.analysed)).toBe(
      true,
    );
    expect(result.largestCacheWrites.some((write) => !write.analysed)).toBe(
      true,
    );
  });

  it('orders each breakdown costliest first, leaves the null-cost group last, and caps none of them', () => {
    const members = Array.from({ length: 12 }, (_, index) => `m${index}`);
    const rows = [
      ...members.map((member, index) =>
        row({
          runId: `run-${member}`,
          memberId: member,
          agentKind: 'claude',
          model: `model-${member}`,
          cwd: `/work/${member}`,
          costUsd: index + 1,
        }),
      ),
      row({
        runId: 'run-null',
        memberId: 'm-null',
        model: 'model-null',
        cwd: null,
        costUsd: null,
      }),
    ];
    const threads = [
      ...members.map((member) => thread(`run-${member}`)),
      thread('run-null'),
    ];

    const result = fold({ threads, rows });

    const costliestFirst = [...members].reverse();
    expect(result.byMember.map((group) => group.member)).toEqual([
      ...costliestFirst,
      'm-null',
    ]);
    expect(result.byProject.map((group) => group.project)).toEqual([
      ...costliestFirst.map((member) => `project-/work/${member}`),
      null,
    ]);
    expect(result.byModel.map((group) => group.model)).toEqual([
      ...costliestFirst.map((member) => `model-${member}`),
      'model-null',
    ]);
    expect(result.byMember).toHaveLength(13);
    expect(result.byProject).toHaveLength(13);
    expect(result.byModel).toHaveLength(13);
  });
});
