import { describe, expect, it } from 'vitest';

import {
  cliTurnDurationMs,
  servedWorkedMs,
  type WallClockRow,
  wallMeasuredTurns,
} from './wall-worked';

let seq = 0;

/** One row of node `a` (or `nodeId`) at `at` ms, in the order written. */
function row(
  kind: string,
  at: number,
  payload: Record<string, unknown> = {},
  nodeId: string | null = 'a',
): WallClockRow {
  seq += 1;
  return {
    seq,
    kind,
    nodeId,
    role: null,
    createdAt: new Date(at),
    payload: JSON.stringify(payload),
  };
}

const running = (at: number, extra: Record<string, unknown> = {}) =>
  row('status', at, { status: 'running', ...extra });
const settle = (at: number, extra: Record<string, unknown> = {}) =>
  row('turn_complete', at, { usage: null, stopReason: 'end_turn', ...extra });

describe("wallMeasuredTurns — a team's nodes", () => {
  const nodes = (rows: WallClockRow[]) => wallMeasuredTurns(rows, 'nodes');

  it('measures a turn from its running row to its settle', () => {
    const end = settle(9_000);
    expect(nodes([running(1_000), end])).toEqual([
      { seq: end.seq, nodeId: 'a', ms: 8_000 },
    ]);
  });

  it('subtracts the stretch an approval card parked the turn', () => {
    const end = settle(10_000);
    const rows = [
      running(0),
      row('approval_request', 2_000, { id: 'card-1' }),
      row('approval_verdict', 5_000, { id: 'card-1', allow: true }),
      end,
    ];
    expect(nodes(rows)).toEqual([{ seq: end.seq, nodeId: 'a', ms: 7_000 }]);
  });

  it('pairs a verdict that carries no callId with its call conversation card', () => {
    // The executor writes a callee's verdict with no `callId`; keyed by the
    // conversation alone it would never close, and the turn would read as
    // parked from the card to the settle.
    const end = settle(10_000, { callId: 'call-1' });
    const rows = [
      running(0, { callId: 'call-1' }),
      row('approval_request', 2_000, { id: 'card-1', callId: 'call-1' }),
      row('unanswerable', 3_000, { id: 'card-1' }),
      end,
    ];
    expect(nodes(rows)).toEqual([{ seq: end.seq, nodeId: 'a', ms: 9_000 }]);
  });

  it('parks a card still open at the settle up to the settle', () => {
    const end = settle(10_000);
    const rows = [
      running(0),
      row('approval_request', 4_000, { id: 'card-1' }),
      end,
    ];
    expect(nodes(rows)).toEqual([{ seq: end.seq, nodeId: 'a', ms: 4_000 }]);
  });

  it('leaves a turn its CLI timed to the CLI figure', () => {
    expect(
      nodes([running(0), settle(9_000, { usage: { durationMs: 5_000 } })]),
    ).toEqual([]);
  });

  it('measures two calls of one node interleaved as two turns', () => {
    // Keyed by the node alone, call-2's turn would be measured from call-1's
    // start (0) and read 12s.
    const one = settle(10_000, { callId: 'call-1' });
    const two = settle(12_000, { callId: 'call-2' });
    const rows = [
      running(0, { callId: 'call-1' }),
      running(6_000, { callId: 'call-2' }),
      one,
      two,
    ];
    expect(nodes(rows)).toEqual([
      { seq: one.seq, nodeId: 'a', ms: 10_000 },
      { seq: two.seq, nodeId: 'a', ms: 6_000 },
    ]);
  });

  it.each(['error', 'turn_cancelled'])(
    'does not measure a turn that ended in %s, and the next turn starts afresh',
    (kind) => {
      const next = settle(30_000);
      const rows = [
        running(0),
        row(kind, 5_000, { message: 'boom' }),
        running(20_000),
        next,
      ];
      expect(nodes(rows)).toEqual([{ seq: next.seq, nodeId: 'a', ms: 10_000 }]);
    },
  );

  it("closes an off-turn stretch on the ending status, so the next turn is not measured from the stretch's start", () => {
    // On ACP the executor answers an off-turn `running` with a `completed`
    // status only when the next turn starts — read through, the next turn
    // would count the idle gap between them (here 60s).
    const end = settle(70_000);
    const rows = [
      running(0, { offTurn: true }),
      row('status', 60_000, { status: 'completed' }),
      running(60_000),
      end,
    ];
    expect(nodes(rows)).toEqual([{ seq: end.seq, nodeId: 'a', ms: 10_000 }]);
  });

  it('measures the open turn from a timed continuation inside it, and no second turn for a settle it answered', () => {
    const rows = [
      running(0),
      settle(4_000, { insideTurn: true, usage: { durationMs: 3_000 } }),
      settle(9_000, { answeredByContinuation: true }),
    ];
    expect(nodes(rows)).toEqual([]);
    const later = settle(9_000);
    expect(
      nodes([
        running(0),
        settle(4_000, { insideTurn: true, usage: { durationMs: 3_000 } }),
        later,
      ]),
    ).toEqual([{ seq: later.seq, nodeId: 'a', ms: 5_000 }]);
  });

  it('measures nothing for a settle with no start, or a run-level row', () => {
    expect(nodes([settle(9_000)])).toEqual([]);
    expect(
      nodes([
        row('status', 0, { status: 'running' }, null),
        row('turn_complete', 9_000, {}, null),
      ]),
    ).toEqual([]);
  });
});

describe("wallMeasuredTurns — a 1:1 chat's agent", () => {
  const chat = (rows: WallClockRow[]) => wallMeasuredTurns(rows, 'chat');
  /** A chat row: no node, and a role on a message. */
  const chatRow = (
    kind: string,
    at: number,
    payload: Record<string, unknown> = {},
    role: string | null = null,
  ): WallClockRow => ({ ...row(kind, at, payload, null), role });
  const said = (at: number) => chatRow('message', at, {}, 'user');
  const chatSettle = (at: number, extra: Record<string, unknown> = {}) =>
    chatRow('turn_complete', at, { usage: null, ...extra });

  it("measures a turn from the user's message to its settle", () => {
    const end = chatSettle(9_000);
    expect(chat([said(1_000), end])).toEqual([
      { seq: end.seq, nodeId: null, ms: 8_000 },
    ]);
  });

  it('does not restart the clock for a message delivered into a running turn', () => {
    const end = chatSettle(10_000);
    expect(chat([said(0), said(6_000), end])).toEqual([
      { seq: end.seq, nodeId: null, ms: 10_000 },
    ]);
  });

  it("opens no turn on the agent's own message", () => {
    expect(
      chat([chatRow('message', 0, {}, 'assistant'), chatSettle(9_000)]),
    ).toEqual([]);
  });

  it('subtracts a parked card and leaves a CLI-timed turn to the CLI', () => {
    const end = chatSettle(10_000);
    expect(
      chat([
        said(0),
        chatRow('approval_request', 2_000, { id: 'card-1' }),
        chatRow('approval_verdict', 5_000, { id: 'card-1' }),
        end,
        said(20_000),
        chatSettle(29_000, { usage: { durationMs: 4_000 } }),
      ]),
    ).toEqual([{ seq: end.seq, nodeId: null, ms: 7_000 }]);
  });

  it('does not measure a turn that ended in error, a boot-interrupted one included', () => {
    const next = chatSettle(40_000);
    expect(
      chat([
        said(0),
        chatRow('error', 5_000, { interrupted: true }),
        said(30_000),
        next,
      ]),
    ).toEqual([{ seq: next.seq, nodeId: null, ms: 10_000 }]);
  });

  it("reads no team node's rows, and the node fold reads no chat rows", () => {
    const rows = [running(0), settle(9_000)];
    expect(chat(rows)).toEqual([]);
    expect(wallMeasuredTurns([said(0), chatSettle(9_000)], 'nodes')).toEqual(
      [],
    );
  });
});

describe('servedWorkedMs', () => {
  it('adds the wall sum to the CLI total, and stays null when neither measured', () => {
    expect(servedWorkedMs(5_000, 3_000)).toBe(8_000);
    expect(servedWorkedMs(null, 3_000)).toBe(3_000);
    expect(servedWorkedMs(5_000, undefined)).toBe(5_000);
    expect(servedWorkedMs(null, null)).toBeNull();
  });
});

describe('cliTurnDurationMs', () => {
  it('takes a finite non-negative figure, zero included, and nothing else', () => {
    expect(cliTurnDurationMs({ usage: { durationMs: 0 } })).toBe(0);
    expect(cliTurnDurationMs({ usage: { durationMs: 1_500 } })).toBe(1_500);
    expect(cliTurnDurationMs({ usage: { durationMs: -1 } })).toBeNull();
    expect(cliTurnDurationMs({ usage: { durationMs: '5' } })).toBeNull();
    expect(cliTurnDurationMs({ usage: null })).toBeNull();
  });
});
