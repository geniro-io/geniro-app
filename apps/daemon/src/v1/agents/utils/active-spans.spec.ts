import { describe, expect, it } from 'vitest';

import { activeSpansFrom, mergeSpans, type SpanRow } from './active-spans';

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const status = (nodeId: string, s: number, value: string): SpanRow => ({
  kind: 'status',
  nodeId,
  createdAt: at(s),
  payload: JSON.stringify({ nodeId, status: value }),
});
const done = (nodeId: string, s: number, durationMs?: number): SpanRow => ({
  kind: 'turn_complete',
  nodeId,
  createdAt: at(s),
  payload: JSON.stringify(
    durationMs === undefined ? { usage: {} } : { usage: { durationMs } },
  ),
});

describe('activeSpansFrom', () => {
  it('merges two agents working at once into ONE stretch — a clock, not a sum', () => {
    // The reported case: a Manager's turn stays open while its Engineer works,
    // so summing the two ran the header's clock at 2 s/s.
    const spans = activeSpansFrom([
      status('manager', 0, 'running'),
      status('engineer', 10, 'running'),
      done('engineer', 70, 60_000),
      done('manager', 100, 100_000),
    ]);

    expect(spans).toEqual([{ startMs: T0, endMs: T0 + 100_000 }]);
  });

  it('measures a turn with no CLI timing from its node’s running row', () => {
    // cursor reports no duration over ACP; without the fallback its stretch
    // would be missing from the clock altogether.
    const spans = activeSpansFrom([status('qa', 5, 'running'), done('qa', 35)]);

    expect(spans).toEqual([{ startMs: T0 + 5000, endMs: T0 + 35_000 }]);
  });

  it('does not lend a FAILED turn’s start to the node’s next turn', () => {
    const spans = activeSpansFrom([
      status('qa', 0, 'running'),
      status('qa', 10, 'failed'),
      status('qa', 100, 'running'),
      done('qa', 130),
    ]);

    expect(spans).toEqual([{ startMs: T0 + 100_000, endMs: T0 + 130_000 }]);
  });

  it('leaves out a turn nothing measured rather than inventing a stretch', () => {
    expect(activeSpansFrom([done('qa', 30)])).toEqual([]);
  });
});

describe('mergeSpans', () => {
  it('keeps disjoint stretches apart and joins touching ones', () => {
    expect(
      mergeSpans([
        { startMs: 50, endMs: 60 },
        { startMs: 0, endMs: 10 },
        { startMs: 10, endMs: 20 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 50, endMs: 60 },
    ]);
  });
});
