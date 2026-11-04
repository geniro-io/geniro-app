import { describe, expect, it } from 'vitest';

import {
  atSecond,
  WATERFALL_FROM,
  wfCall,
  wfDto,
  wfLane,
  wfTurn,
} from '../__tests__/waterfall-fixtures';
import {
  SEQUENCE_BREAK_PX,
  SEQUENCE_ROW_MIN,
  sequenceLayout,
} from './run-waterfall-sequence-layout';

const WHOLE = { from: WATERFALL_FROM, to: WATERFALL_FROM + 10 * 3_600_000 };

describe('sequenceLayout', () => {
  it('gives every arrow a row of its own, however close in time the calls were', () => {
    const layout = sequenceLayout(
      wfDto(36_000, {
        lanes: [wfLane('manager'), wfLane('engineer'), wfLane('qa')],
        calls: [
          wfCall('manager', 'engineer', 10, 20, { callId: 'a' }),
          wfCall('manager', 'qa', 10, 30, { callId: 'b' }),
          wfCall('manager', 'engineer', 11, 15, { callId: 'c', mode: 'sync' }),
        ],
      }),
      WHOLE,
      1,
    );

    const rows = [
      ...layout.calls.map((call) => call.y),
      ...layout.calls.flatMap((call) =>
        call.backY === null ? [] : [call.backY],
      ),
    ].sort((a, b) => a - b);
    expect(rows).toHaveLength(4);
    rows.slice(1).forEach((row, at) => {
      expect(row - rows[at]!).toBeGreaterThanOrEqual(SEQUENCE_ROW_MIN);
    });
    expect(layout.calls.map((call) => [call.from, call.to])).toEqual([
      [0, 1],
      [0, 2],
      [0, 1],
    ]);
  });

  it('draws a long stretch with nothing in it as a short break, and cuts a turn that runs through one', () => {
    const layout = sequenceLayout(
      wfDto(36_000, {
        lanes: [wfLane('manager')],
        turns: [wfTurn('manager', 0, 4 * 3600)],
        calls: [
          wfCall('manager', 'manager', 60, 120, { callId: 'a' }),
          wfCall('manager', 'manager', 3 * 3600, 3 * 3600 + 60, {
            callId: 'b',
          }),
        ],
      }),
      WHOLE,
      1,
    );

    expect(layout.breaks).toHaveLength(2);
    for (const cut of layout.breaks) {
      expect(cut.y1 - cut.y0).toBe(SEQUENCE_BREAK_PX);
    }
    expect(layout.turns[0]!.broken).toBe(true);
    expect(layout.timeAt(layout.yAt(Date.parse(atSecond(60))))).toBe(
      Date.parse(atSecond(60)),
    );
  });

  it('numbers calls by when they were made and frames the ones an agent made at once', () => {
    const layout = sequenceLayout(
      wfDto(36_000, {
        lanes: [wfLane('manager'), wfLane('engineer'), wfLane('qa')],
        calls: [
          wfCall('manager', 'qa', 3600, 3700, { callId: 'late' }),
          wfCall('manager', 'engineer', 10, 600, { callId: 'a' }),
          wfCall('manager', 'qa', 40, 600, { callId: 'b' }),
          wfCall('engineer', 'qa', 70, 600, { callId: 'other' }),
        ],
      }),
      WHOLE,
      1,
    );

    expect(layout.calls.map((call) => call.number)).toEqual([4, 1, 2, 3]);
    expect(layout.groups).toHaveLength(1);
    const group = layout.groups[0]!;
    expect(group.calls).toEqual([1, 2]);
    expect([group.minColumn, group.maxColumn]).toEqual([0, 2]);
    const [first, second] = [layout.calls[1]!, layout.calls[2]!];
    expect(group.y0).toBeLessThan(first.y - SEQUENCE_ROW_MIN / 2);
    expect(group.y1).toBeGreaterThan(second.y);
    expect(layout.calls[3]!.y).toBeGreaterThan(group.y1 + 8);
  });

  it('keeps a parallel group’s frame clear of the break before it', () => {
    const layout = sequenceLayout(
      wfDto(36_000, {
        lanes: [wfLane('manager'), wfLane('engineer'), wfLane('qa')],
        calls: [
          wfCall('manager', 'engineer', 10, 60, { callId: 'early' }),
          wfCall('manager', 'engineer', 7200, 7800, { callId: 'a' }),
          wfCall('manager', 'qa', 7210, 7800, { callId: 'b' }),
        ],
      }),
      WHOLE,
      1,
    );

    expect(layout.breaks).toHaveLength(1);
    expect(layout.groups[0]!.y0).toBeGreaterThanOrEqual(
      layout.breaks[0]!.y1 + 8,
    );
  });

  it('sets two turns of one agent at once side by side', () => {
    const layout = sequenceLayout(
      wfDto(36_000, {
        lanes: [wfLane('engineer')],
        turns: [wfTurn('engineer', 0, 600), wfTurn('engineer', 60, 300)],
      }),
      WHOLE,
      1,
    );

    expect(layout.turns.map((turn) => turn.slot)).toEqual([0, 1]);
    expect(layout.slots).toEqual([2]);
  });
});
