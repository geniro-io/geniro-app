import { describe, expect, it } from 'vitest';

import { type CallClockRow, callClocksFrom } from './call-clock';

let seq = 0;
function row(
  kind: string,
  atMs: number,
  payload: Record<string, unknown>,
  memberId = 'engineer',
): CallClockRow {
  seq += 1;
  return {
    seq,
    kind,
    memberId,
    createdAt: new Date(atMs),
    payload: JSON.stringify(payload),
  };
}

const status = (callId: string, value: string, atMs: number): CallClockRow =>
  row('status', atMs, { nodeId: 'engineer', status: value, callId });

describe('callClocksFrom', () => {
  it('runs through a monitor hold and the wakes that write no running row', () => {
    const start = status('call-1', 'running', 0);
    const rows = [
      start,
      row('turn_complete', 10_000, { callId: 'call-1', usage: {} }),
      row('system', 50_000, { woke: true, monitors: [], callId: 'call-1' }),
      row('turn_complete', 60_000, { callId: 'call-1', usage: {} }),
    ];

    const clock = callClocksFrom(rows).get('call-1');

    expect(clock).toEqual({
      closedMs: 0,
      runningSince: 0,
      parkedMs: 0,
      parkedSince: null,
      openCards: [],
      throughSeq: start.seq,
    });
  });

  it('closes a stretch at its ending status and counts the whole of it', () => {
    const start = status('call-1', 'running', 0);
    const end = status('call-1', 'completed', 90_000);
    const clock = callClocksFrom([start, end]).get('call-1');

    expect(clock).toMatchObject({
      closedMs: 90_000,
      runningSince: null,
      throughSeq: end.seq,
    });
  });

  it("leaves out a card's wait on the user, paired by member and id", () => {
    const clock = callClocksFrom([
      status('call-1', 'running', 0),
      row('approval_request', 10_000, { id: 'q1', callId: 'call-1' }),
      row('approval_verdict', 40_000, { id: 'q1' }),
      status('call-1', 'completed', 100_000),
    ]).get('call-1');

    expect(clock?.closedMs).toBe(70_000);
  });

  it('parks once for two cards open together', () => {
    const clock = callClocksFrom([
      status('call-1', 'running', 0),
      row('approval_request', 10_000, { id: 'q1', callId: 'call-1' }),
      row('approval_request', 20_000, { id: 'q2', callId: 'call-1' }),
      row('approval_verdict', 30_000, { id: 'q1' }),
      row('unanswerable', 50_000, { id: 'q2' }),
      status('call-1', 'completed', 100_000),
    ]).get('call-1');

    expect(clock?.closedMs).toBe(60_000);
  });

  it('keeps a card still open as the parked state a client continues from', () => {
    const request = row('approval_request', 10_000, {
      id: 'q1',
      callId: 'call-1',
    });
    const clock = callClocksFrom([status('call-1', 'running', 0), request]).get(
      'call-1',
    );

    expect(clock).toMatchObject({
      runningSince: 0,
      parkedSince: 10_000,
      openCards: ['q1'],
    });
  });

  it('parks a card still open at the ending up to the ending', () => {
    const clock = callClocksFrom([
      status('call-1', 'running', 0),
      row('approval_request', 10_000, { id: 'q1', callId: 'call-1' }),
      status('call-1', 'cancelled', 30_000),
      row('approval_verdict', 40_000, { id: 'q1' }),
    ]).get('call-1');

    expect(clock).toMatchObject({ closedMs: 10_000, parkedSince: null });
  });

  it("counts a callee's own stretch after its call settled", () => {
    const clock = callClocksFrom([
      status('call-1', 'running', 0),
      status('call-1', 'completed', 20_000),
      row('status', 100_000, {
        nodeId: 'engineer',
        status: 'running',
        callId: 'call-1',
        offTurn: true,
      }),
      status('call-1', 'completed', 130_000),
    ]).get('call-1');

    expect(clock?.closedMs).toBe(50_000);
  });

  it('keeps two calls of one member apart', () => {
    const clocks = callClocksFrom([
      status('call-1', 'running', 0),
      status('call-2', 'running', 30_000),
      status('call-1', 'completed', 40_000),
    ]);

    expect(clocks.get('call-1')).toMatchObject({
      closedMs: 40_000,
      runningSince: null,
    });
    expect(clocks.get('call-2')).toMatchObject({
      closedMs: 0,
      runningSince: 30_000,
    });
  });

  it("reads no member's own conversation", () => {
    const clocks = callClocksFrom([
      row('status', 0, { nodeId: 'engineer', status: 'running' }),
      row('status', 5_000, { nodeId: 'engineer', status: 'completed' }),
    ]);

    expect(clocks.size).toBe(0);
  });
});
