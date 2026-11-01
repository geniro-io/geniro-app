import { describe, expect, it } from 'vitest';

import {
  activeSpansFrom,
  mergeSpans,
  type SpanRow,
  subtractSpans,
} from './active-spans';

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const status = (memberId: string, s: number, value: string): SpanRow => ({
  kind: 'status',
  memberId,
  createdAt: at(s),
  payload: JSON.stringify({ nodeId: memberId, status: value }),
});
const done = (memberId: string, s: number, durationMs?: number): SpanRow => ({
  kind: 'turn_complete',
  memberId,
  createdAt: at(s),
  payload: JSON.stringify(
    durationMs === undefined ? { usage: {} } : { usage: { durationMs } },
  ),
});
const row = (
  kind: string,
  memberId: string,
  s: number,
  payload: Record<string, unknown>,
): SpanRow => ({
  kind,
  memberId,
  createdAt: at(s),
  payload: JSON.stringify(payload),
});
const asked = (memberId: string, s: number, id: string): SpanRow =>
  row('approval_request', memberId, s, { id, toolName: 'ask_user_question' });
const answered = (memberId: string, s: number, id: string): SpanRow =>
  row('approval_verdict', memberId, s, { id, allow: true });
/** A Manager awaiting its Engineer, who asks the user at 20s and is answered at 80s. */
const parkedCall = (between: SpanRow[] = []): SpanRow[] => [
  status('manager', 0, 'running'),
  status('engineer', 10, 'running'),
  asked('engineer', 20, 'q1'),
  ...between,
  answered('engineer', 80, 'q1'),
  done('engineer', 90, 30_000),
  done('manager', 100, 100_000),
];

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

  it('measures a turn with no CLI timing from its member’s running row', () => {
    // cursor reports no duration over ACP; without the fallback its stretch
    // would be missing from the clock altogether.
    const spans = activeSpansFrom([status('qa', 5, 'running'), done('qa', 35)]);

    expect(spans).toEqual([{ startMs: T0 + 5000, endMs: T0 + 35_000 }]);
  });

  it('does not lend a FAILED turn’s start to the member’s next turn', () => {
    const spans = activeSpansFrom([
      status('qa', 0, 'running'),
      status('qa', 10, 'failed'),
      status('qa', 100, 'running'),
      done('qa', 130),
    ]);

    expect(spans).toEqual([{ startMs: T0 + 100_000, endMs: T0 + 130_000 }]);
  });

  it('reaches back by the CLI’s own duration for a turn with no running row', () => {
    expect(activeSpansFrom([done('qa', 100, 30_000)])).toEqual([
      { startMs: T0 + 70_000, endMs: T0 + 100_000 },
    ]);
  });

  it('does not lend an off-turn stretch’s start to the member’s next turn', () => {
    // An off-turn badge (`running`) restored to `completed` writes no
    // `turn_complete`; measured from it, the next turn would cover the idle hour.
    const spans = activeSpansFrom([
      status('engineer', 0, 'running'),
      status('engineer', 30, 'completed'),
      status('engineer', 3600, 'running'),
      done('engineer', 3660, 60_000),
    ]);

    expect(spans).toEqual([{ startMs: T0 + 3_600_000, endMs: T0 + 3_660_000 }]);
  });

  it('keeps each parallel call’s own start when another call of the member ends', () => {
    // One member, two calls at once; the first call's `completed` must not erase
    // the second's start, or the second (no CLI timing) drops off the clock.
    const call = (s: number, kind: string, callId: string, extra = {}) =>
      row(kind, 'qa', s, { memberId: 'qa', callId, ...extra });
    expect(
      activeSpansFrom([
        call(0, 'status', 'c1', { status: 'running' }),
        call(10, 'status', 'c3', { status: 'running' }),
        call(20, 'turn_complete', 'c1', { usage: {} }),
        call(21, 'status', 'c1', { status: 'completed' }),
        call(50, 'turn_complete', 'c3', { usage: {} }),
      ]),
    ).toEqual([{ startMs: T0, endMs: T0 + 50_000 }]);
  });

  it('leaves out a turn nothing measured rather than inventing a stretch', () => {
    expect(activeSpansFrom([done('qa', 30)])).toEqual([]);
  });
});

describe('activeSpansFrom — waiting on the user', () => {
  it('stops the clock while a card waits on the user and nothing runs in the background', () => {
    // A Manager in `await_agent` and an Engineer parked on a question are two
    // open turns and no work.
    expect(activeSpansFrom(parkedCall())).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('keeps counting through a card while a background shell runs', () => {
    expect(
      activeSpansFrom(
        parkedCall([
          row('shell_open', 'engineer', 30, { id: 'call-7', workId: 'b1' }),
          row('shell_info', 'engineer', 50, { id: null, workId: 'b1' }),
        ]),
      ),
    ).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 30_000, endMs: T0 + 50_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('closes a shell by its launching call when the settle names no work id', () => {
    expect(
      activeSpansFrom(
        parkedCall([
          row('shell_open', 'engineer', 30, { id: 'call-7', workId: 'b1' }),
          row('shell_info', 'engineer', 50, { id: 'call-7' }),
        ]),
      ),
    ).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 30_000, endMs: T0 + 50_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('keeps counting through a card while a background delegate is out', () => {
    expect(
      activeSpansFrom(
        parkedCall([
          row('subagent_info', 'engineer', 25, {
            id: 'd1',
            backgroundOpen: true,
          }),
          row('subagent_info', 'engineer', 40, { id: 'd1', label: 'review' }),
          row('subagent_info', 'engineer', 60, {
            id: 'd1',
            backgroundOpen: true,
            backgroundOutcome: 'completed',
          }),
        ]),
      ),
    ).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 25_000, endMs: T0 + 60_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('closes a delegate whose row says `backgroundOpen: false`', () => {
    expect(
      activeSpansFrom(
        parkedCall([
          row('subagent_info', 'engineer', 25, {
            id: 'd1',
            backgroundOpen: true,
          }),
          row('subagent_info', 'engineer', 60, {
            id: 'd1',
            backgroundOpen: false,
          }),
        ]),
      ),
    ).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 25_000, endMs: T0 + 60_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('times a re-announced card from its first request', () => {
    expect(
      activeSpansFrom([
        status('qa', 0, 'running'),
        asked('qa', 10, 'q1'),
        asked('qa', 30, 'q1'),
        answered('qa', 40, 'q1'),
        done('qa', 50),
      ]),
    ).toEqual([
      { startMs: T0, endMs: T0 + 10_000 },
      { startMs: T0 + 40_000, endMs: T0 + 50_000 },
    ]);
  });

  it('keeps two members’ cards apart when their per-process ids collide', () => {
    // ACP and codex number requests per process, so two agents can both have
    // card `n:0` open; answering one must not end the other's wait.
    expect(
      activeSpansFrom([
        status('qa', 0, 'running'),
        status('engineer', 0, 'running'),
        asked('qa', 10, 'n:0'),
        asked('engineer', 20, 'n:0'),
        answered('qa', 30, 'n:0'),
        answered('engineer', 60, 'n:0'),
        done('qa', 70),
        done('engineer', 80),
      ]),
    ).toEqual([
      { startMs: T0, endMs: T0 + 10_000 },
      { startMs: T0 + 60_000, endMs: T0 + 80_000 },
    ]);
  });

  it.each([
    [
      'shell',
      row('shell_open', 'engineer', 30, { id: 'call-7', workId: 'b1' }),
    ],
    [
      'delegate',
      row('subagent_info', 'engineer', 30, { id: 'd1', backgroundOpen: true }),
    ],
  ])(
    'keeps counting through a card while a background %s is still out',
    (_, opened) => {
      expect(activeSpansFrom(parkedCall([opened]))).toEqual([
        { startMs: T0, endMs: T0 + 20_000 },
        { startMs: T0 + 30_000, endMs: T0 + 100_000 },
      ]);
    },
  );

  it('ends a card that lost its close at its conversation’s next turn', () => {
    // A verdict delivered after the turn settled writes no row; left open, the
    // card would cut every later stretch of the run.
    expect(
      activeSpansFrom([
        status('qa', 0, 'running'),
        asked('qa', 10, 'q1'),
        done('qa', 20),
        row('status', 'qa', 100, { memberId: 'qa', status: 'running' }),
        done('qa', 160),
      ]),
    ).toEqual([
      { startMs: T0, endMs: T0 + 10_000 },
      { startMs: T0 + 100_000, endMs: T0 + 160_000 },
    ]);
  });

  it.each([
    [
      'another member',
      row('status', 'qa', 40, { memberId: 'qa', status: 'running' }),
    ],
    [
      'another call of the same member',
      row('status', 'engineer', 40, {
        memberId: 'engineer',
        callId: 'c2',
        status: 'running',
      }),
    ],
    [
      'an off-turn badge of the same conversation',
      row('status', 'engineer', 40, {
        memberId: 'engineer',
        status: 'running',
        offTurn: true,
      }),
    ],
  ])('leaves a card open on %s', (_, started) => {
    expect(activeSpansFrom(parkedCall([started]))).toEqual([
      { startMs: T0, endMs: T0 + 20_000 },
      { startMs: T0 + 80_000, endMs: T0 + 100_000 },
    ]);
  });

  it('closes a card on `unanswerable` as on a verdict', () => {
    expect(
      activeSpansFrom([
        status('qa', 0, 'running'),
        asked('qa', 10, 'q1'),
        row('unanswerable', 'qa', 40, { id: 'q1' }),
        done('qa', 50),
      ]),
    ).toEqual([
      { startMs: T0, endMs: T0 + 10_000 },
      { startMs: T0 + 40_000, endMs: T0 + 50_000 },
    ]);
  });

  it('stops at a card nobody answered before the turn ended', () => {
    expect(
      activeSpansFrom([
        status('qa', 0, 'running'),
        asked('qa', 10, 'q1'),
        done('qa', 50),
      ]),
    ).toEqual([{ startMs: T0, endMs: T0 + 10_000 }]);
  });

  it('measures from the running row, so a CLI figure that already left out its own card is not cut twice', () => {
    // claude's `durationMs` excludes its own parked stretch; reaching back by
    // it from the end would place the span over the wrong 70 seconds.
    expect(
      activeSpansFrom([
        status('engineer', 0, 'running'),
        asked('engineer', 10, 'q1'),
        answered('engineer', 40, 'q1'),
        done('engineer', 100, 70_000),
      ]),
    ).toEqual([
      { startMs: T0, endMs: T0 + 10_000 },
      { startMs: T0 + 40_000, endMs: T0 + 100_000 },
    ]);
  });
});

describe('subtractSpans', () => {
  it('cuts each stretch out, splitting a span it lands inside', () => {
    expect(
      subtractSpans(
        [
          { startMs: 0, endMs: 100 },
          { startMs: 200, endMs: 300 },
        ],
        [
          { startMs: 20, endMs: 30 },
          { startMs: 90, endMs: 210 },
          { startMs: 250, endMs: Number.POSITIVE_INFINITY },
        ],
      ),
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 30, endMs: 90 },
      { startMs: 210, endMs: 250 },
    ]);
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
