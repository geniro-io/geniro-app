import { describe, expect, it } from 'vitest';

import {
  WATERFALL_FROM,
  wfCall,
  wfDto,
  wfLane,
  wfTurn,
} from '../__tests__/waterfall-fixtures';
import { breakdownRows, toolRows } from './run-waterfall-breakdown';

const whole = (seconds: number) => ({
  from: WATERFALL_FROM,
  to: WATERFALL_FROM + seconds * 1000,
});
const between = (from: number, to: number) => ({
  from: WATERFALL_FROM + from * 1000,
  to: WATERFALL_FROM + to * 1000,
});

describe('breakdownRows', () => {
  it("takes a lane's own price and turn count on the whole run", () => {
    // A polled-spend lane prices no turn on the wire: its money is the lane's,
    // and summing its turns would report it as unmeasured.
    const data = wfDto(100, {
      lanes: [
        wfLane('qa', { costUsd: 4.5, turns: 3, agentKind: 'cursor-agent' }),
      ],
      turns: [wfTurn('qa', 0, 50)],
    });

    const [row] = breakdownRows(data, whole(100), 'agent', undefined);

    expect(row?.costUsd).toBe(4.5);
    expect(row?.turns).toBe(3);
  });

  it("counts a turn's money where it ENDED and its time where it overlaps", () => {
    // Turn A ends inside the window (its price counts); turn B starts inside
    // but ends after it (its time counts, its price does not — it was priced
    // after the window).
    const data = wfDto(100, {
      lanes: [wfLane('eng', { costUsd: 5 })],
      turns: [
        wfTurn('eng', 0, 30, { costUsd: 2 }),
        wfTurn('eng', 40, 90, { costUsd: 3 }),
      ],
    });

    const [row] = breakdownRows(data, between(20, 60), 'agent', undefined);

    expect(row?.costUsd).toBe(2);
    expect(row?.turns).toBe(2);
    // 10s of A (20–30) plus 20s of B (40–60).
    expect(row?.workedMs).toBe(30_000);
  });

  it('adds what callees priced while answering a lane, once per turn', () => {
    // Two overlapping calls to the same engineer must not count its turn twice.
    const data = wfDto(100, {
      lanes: [wfLane('mgr', { costUsd: 1 }), wfLane('eng', { costUsd: 2 })],
      turns: [
        wfTurn('mgr', 0, 10, { costUsd: 1 }),
        wfTurn('eng', 20, 50, { costUsd: 2 }),
      ],
      calls: [wfCall('mgr', 'eng', 10, 60), wfCall('mgr', 'eng', 15, 55)],
    });

    const rows = breakdownRows(data, whole(100), 'agent', undefined);

    expect(rows.find((row) => row.key === 'mgr')?.withCalleesUsd).toBe(3);
    expect(rows.find((row) => row.key === 'eng')?.withCalleesUsd).toBe(2);
  });

  it("counts a callee's price toward its caller only for turns that ended in the window", () => {
    // The engineer answered with two turns; zoomed onto the first, only that
    // turn's money is the manager's "with callees" figure.
    const data = wfDto(100, {
      lanes: [wfLane('mgr'), wfLane('eng')],
      turns: [
        wfTurn('mgr', 0, 5, { costUsd: 1 }),
        wfTurn('eng', 10, 30, { costUsd: 2 }),
        wfTurn('eng', 40, 70, { costUsd: 4 }),
      ],
      calls: [wfCall('mgr', 'eng', 5, 80)],
    });

    const rows = breakdownRows(data, between(0, 35), 'agent', undefined);

    expect(rows.find((row) => row.key === 'mgr')?.withCalleesUsd).toBe(3);
  });

  it('reads the cache share only off turns that reported both figures', () => {
    // The second turn reported a cache read but no input: it would drag the
    // share toward 100% on a figure nobody measured.
    const data = wfDto(100, {
      lanes: [wfLane('eng')],
      turns: [
        wfTurn('eng', 0, 10, { cacheReadTokens: 300, inputTokens: 100 }),
        wfTurn('eng', 20, 30, { cacheReadTokens: 9_000, inputTokens: null }),
      ],
    });

    const [row] = breakdownRows(data, whole(100), 'agent', undefined);

    expect(row?.cacheShare).toBe(75);
  });

  it('folds by model, naming a turn that reported none', () => {
    const data = wfDto(100, {
      lanes: [wfLane('eng')],
      turns: [
        wfTurn('eng', 0, 10, { model: 'opus-5', costUsd: 1 }),
        wfTurn('eng', 20, 30, { model: 'opus-5', costUsd: 2 }),
        wfTurn('eng', 40, 50, { model: null }),
      ],
    });

    const rows = breakdownRows(data, whole(100), 'model', undefined);

    expect(rows.map((row) => [row.key, row.turns, row.costUsd])).toEqual([
      ['opus-5', 2, 3],
      ['unknown model', 1, null],
    ]);
  });

  it('narrows to the focused agent', () => {
    const data = wfDto(100, {
      lanes: [wfLane('mgr'), wfLane('eng')],
      turns: [wfTurn('mgr', 0, 10), wfTurn('eng', 0, 10)],
    });

    expect(
      breakdownRows(data, whole(100), 'agent', 'eng').map((row) => row.key),
    ).toEqual(['eng']);
  });

  it('keeps the peak context fill, not the last one', () => {
    const data = wfDto(100, {
      lanes: [wfLane('eng')],
      turns: [
        wfTurn('eng', 0, 10, { contextTokens: 180, contextWindowTokens: 200 }),
        wfTurn('eng', 20, 30, { contextTokens: 20, contextWindowTokens: 200 }),
      ],
    });

    expect(
      breakdownRows(data, whole(100), 'agent', undefined)[0]?.peakContext,
    ).toBe(0.9);
  });
});

describe('toolRows', () => {
  it('folds the same tool across agents into one row, busiest counting sub-agents first', () => {
    const data = wfDto(100, {
      toolUse: [
        { nodeId: 'mgr', name: 'Read', calls: 3, delegateCalls: 0 },
        { nodeId: 'eng', name: 'Bash', calls: 2, delegateCalls: 7 },
        { nodeId: 'eng', name: 'Read', calls: 4, delegateCalls: 1 },
      ],
    });

    // Bash has fewer own calls than Read but more in all, so it ranks first.
    expect(toolRows(data, undefined)).toEqual([
      { name: 'Bash', calls: 2, delegateCalls: 7, all: 9 },
      { name: 'Read', calls: 7, delegateCalls: 1, all: 8 },
    ]);
    expect(toolRows(data, 'mgr')).toEqual([
      { name: 'Read', calls: 3, delegateCalls: 0, all: 3 },
    ]);
  });
});

describe('breakdownRows estimated cost', () => {
  it("takes a lane's estimated part on the whole run, null when none", () => {
    const data = wfDto(100, {
      lanes: [
        wfLane('a', { costUsd: 4, estimatedCostUsd: 3 }),
        wfLane('b', { costUsd: 2 }),
      ],
      turns: [wfTurn('a', 0, 50), wfTurn('b', 0, 50)],
    });

    const rows = breakdownRows(data, whole(100), 'agent', undefined);

    expect(rows.map((row) => row.estimatedCostUsd)).toEqual([3, null]);
  });

  it('sums only the estimated turns that ended in the window, by agent and by model', () => {
    const data = wfDto(100, {
      lanes: [wfLane('eng', { costUsd: 6 })],
      turns: [
        wfTurn('eng', 0, 30, { costUsd: 2, estimatedCostUsd: 2, model: 'm1' }),
        wfTurn('eng', 40, 90, { costUsd: 3, model: 'm2' }),
      ],
    });

    const [agent] = breakdownRows(data, between(0, 60), 'agent', undefined);
    const models = breakdownRows(data, whole(100), 'model', undefined);

    expect(agent?.costUsd).toBe(2);
    expect(agent?.estimatedCostUsd).toBe(2);
    expect(
      Object.fromEntries(models.map((row) => [row.key, row.estimatedCostUsd])),
    ).toEqual({ m1: 2, m2: null });
  });

  it('carries the callees’ estimated part into the with-callees figure', () => {
    const data = wfDto(100, {
      lanes: [wfLane('mgr', { costUsd: 1 }), wfLane('eng')],
      turns: [wfTurn('eng', 10, 20, { costUsd: 4, estimatedCostUsd: 4 })],
      calls: [wfCall('mgr', 'eng', 5, 25)],
    });

    const mgr = breakdownRows(data, whole(100), 'agent', undefined).find(
      (row) => row.nodeId === 'mgr',
    );

    expect(mgr?.withCalleesUsd).toBe(5);
    expect(mgr?.withCalleesEstimatedUsd).toBe(4);
    expect(mgr?.estimatedCostUsd).toBeNull();
  });
});
