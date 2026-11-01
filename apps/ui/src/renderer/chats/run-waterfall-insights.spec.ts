import { describe, expect, it } from 'vitest';

import {
  atSecond,
  wfCall,
  wfDto,
  wfLane,
  wfTurn,
  wfWait,
} from '../__tests__/waterfall-fixtures';
import { waterfallInsights } from './run-waterfall-insights';

describe('waterfallInsights', () => {
  it('says nothing about a run with nothing out of the ordinary', () => {
    const data = wfDto(600, {
      lanes: [wfLane('eng')],
      turns: [wfTurn('eng', 0, 600, { costUsd: 1 })],
      criticalPath: [
        {
          kind: 'work',
          memberId: 'eng',
          startedAt: atSecond(0),
          durationMs: 600_000,
        },
      ],
      totals: { ...wfDto(1).totals, costUsd: 1 },
    });

    // The one turn IS the whole run's money — a share of 100% is not news.
    expect(waterfallInsights(data)).toEqual([]);
  });

  it('names the run standing still on a card only when it was on the critical path', () => {
    const wait = wfWait('eng', 100, 200);
    const onPath = wfDto(600, {
      waits: [wait],
      criticalPath: [
        {
          kind: 'waiting_on_user',
          memberId: null,
          startedAt: atSecond(100),
          durationMs: 100_000,
        },
      ],
    });
    const offPath = wfDto(600, { waits: [wait] });

    expect(waterfallInsights(onPath)[0]).toMatchObject({
      id: 'waited',
      target: { kind: 'wait', index: 0 },
    });
    expect(
      waterfallInsights(offPath).map((insight) => insight.id),
    ).not.toContain('waited');
  });

  it('names a sync call that held its caller still, and never an async one', () => {
    const data = wfDto(600, {
      calls: [
        wfCall('mgr', 'eng', 0, 300, { mode: 'sync' }),
        wfCall('mgr', 'res', 0, 400, { mode: 'async' }),
      ],
    });

    const blocked = waterfallInsights(data).filter((insight) =>
      insight.id.startsWith('blocked'),
    );

    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.title).toBe('mgr waited 5m on eng');
    expect(blocked[0]?.target).toEqual({ kind: 'blocked', index: 0 });
  });

  it('names the single most expensive turn, once, when it holds a real share', () => {
    const data = wfDto(600, {
      turns: [
        wfTurn('mgr', 0, 10, { costUsd: 3 }),
        wfTurn('mgr', 20, 30, { costUsd: 4 }),
        wfTurn('eng', 40, 50, { costUsd: 3 }),
      ],
      totals: { ...wfDto(1).totals, costUsd: 10 },
    });

    const expensive = waterfallInsights(data).filter((insight) =>
      insight.id.startsWith('expensive'),
    );

    // Two turns are past 25%; only the priciest is named.
    expect(expensive).toEqual([
      expect.objectContaining({
        title: 'mgr: one turn cost 40% of the run',
        target: { kind: 'turn', index: 1 },
      }),
    ]);
  });

  it('names a failed turn and a failed call, each landing on its own mark', () => {
    const data = wfDto(600, {
      turns: [wfTurn('rev', 0, 60, { outcome: 'failed', costUsd: 0.7 })],
      calls: [wfCall('mgr', 'rev', 0, 60, { status: 'error' })],
    });

    const insights = waterfallInsights(data);

    expect(
      insights.find((insight) => insight.id === 'failed-turn-0'),
    ).toMatchObject({
      title: 'rev: a turn failed',
      target: { kind: 'turn', index: 0 },
    });
    expect(
      insights.find((insight) => insight.id === 'failed-call-0'),
    ).toMatchObject({
      target: { kind: 'call', index: 0 },
    });
  });

  it('marks the failed turn’s cost when geniro priced it', () => {
    const detail = (estimatedCostUsd: number | null): string | undefined =>
      waterfallInsights(
        wfDto(600, {
          turns: [
            wfTurn('rev', 0, 60, {
              outcome: 'failed',
              costUsd: 0.7,
              estimatedCostUsd,
            }),
          ],
        }),
      ).find((insight) => insight.id === 'failed-turn-0')?.detail;

    expect(detail(0.7)).toContain('≈$0.70');
    expect(detail(null)).toContain('$0.70');
    expect(detail(null)).not.toContain('≈');
  });

  it('names the cache collapsing between two turns of one agent', () => {
    const data = wfDto(600, {
      turns: [
        wfTurn('mgr', 0, 10, { cacheReadTokens: 80, inputTokens: 20 }),
        // Another agent's turn in between must not break the comparison.
        wfTurn('eng', 20, 30, { cacheReadTokens: 10, inputTokens: 90 }),
        wfTurn('mgr', 40, 50, { cacheReadTokens: 40, inputTokens: 60 }),
      ],
    });

    const cache = waterfallInsights(data).filter((insight) =>
      insight.id.startsWith('cache'),
    );

    expect(cache).toEqual([
      expect.objectContaining({
        title: 'mgr: cache fell to 40%',
        detail: 'it was 80% the turn before',
        target: { kind: 'turn', index: 2 },
      }),
    ]);
  });

  it('names an agent whose context came close to its window, once, at its fullest', () => {
    const data = wfDto(600, {
      turns: [
        wfTurn('mgr', 0, 10, { contextTokens: 170, contextWindowTokens: 200 }),
        wfTurn('mgr', 20, 30, { contextTokens: 190, contextWindowTokens: 200 }),
        wfTurn('eng', 20, 30, { contextTokens: 100, contextWindowTokens: 200 }),
      ],
    });

    const context = waterfallInsights(data).filter((insight) =>
      insight.id.startsWith('context'),
    );

    expect(context).toHaveLength(1);
    expect(context[0]?.title).toBe('mgr: context at 95%');
    expect(context[0]?.target).toEqual({ kind: 'turn', index: 1 });
  });

  it('names idle time on the critical path as the run as a whole', () => {
    const data = wfDto(100, {
      criticalPath: [
        {
          kind: 'idle',
          memberId: null,
          startedAt: atSecond(0),
          durationMs: 50_000,
        },
      ],
    });

    expect(waterfallInsights(data)).toEqual([
      expect.objectContaining({ id: 'idle', target: null }),
    ]);
  });
});
