import { describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import { OPEN_WORK_KINDS, openCalls, openNodeTurns } from './open-call-work';

let seq = 0;
function row(kind: string, memberId: string | null, payload: unknown): Item {
  seq += 1;
  return { seq, kind, memberId, payload: JSON.stringify(payload) } as Item;
}

describe('openNodeTurns', () => {
  it('pairs running rows with terminal ones per member and call', () => {
    const turns = openNodeTurns([
      row('status', 'a', { nodeId: 'a', status: 'running' }),
      row('status', 'a', { nodeId: 'a', status: 'completed' }),
      row('status', 'a', { nodeId: 'a', status: 'running' }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c1' }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c2' }),
      row('status', 'b', { nodeId: 'b', status: 'failed', callId: 'c2' }),
    ]);

    expect(turns).toEqual([
      { memberId: 'a', callId: null },
      { memberId: 'b', callId: 'c1' },
    ]);
  });

  it('reads a second running row on an open call as that same turn, so one ending settles it', () => {
    const turns = openNodeTurns([
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c1' }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c1' }),
      row('status', 'b', { nodeId: 'b', status: 'completed', callId: 'c1' }),
    ]);

    expect(turns).toEqual([]);
  });

  it('never lets a start-less terminal row settle a later turn', () => {
    const turns = openNodeTurns([
      row('status', 'a', { nodeId: 'a', status: 'skipped' }),
      row('status', 'a', { nodeId: 'a', status: 'running' }),
    ]);

    expect(turns).toEqual([{ memberId: 'a', callId: null }]);
  });
});

describe('openCalls', () => {
  it('returns only calls announced without a result', () => {
    const calls = openCalls([
      row('call_started', 'orch', {
        callId: 'done',
        callerNodeId: 'orch',
        calleeNodeId: 'poet',
        mode: 'sync',
      }),
      row('call_result', 'orch', { callId: 'done', status: 'ok' }),
      row('call_started', 'orch', {
        callId: 'open',
        callerNodeId: 'orch',
        calleeNodeId: 'critic',
        mode: 'async',
      }),
    ]);

    expect(calls).toEqual([
      {
        callId: 'open',
        callerMemberId: 'orch',
        callerConversationId: null,
        calleeMemberId: 'critic',
        mode: 'async',
        member: null,
      },
    ]);
  });

  it('reads the conversation a call was made from, and the pool member it started on', () => {
    const calls = openCalls([
      row('call_started', 'orch', {
        callId: 'open',
        callerNodeId: 'orch',
        callerConversationId: 'call-7',
        calleeNodeId: 'critic',
        mode: 'async',
        member: 2,
      }),
    ]);

    expect(calls).toEqual([
      {
        callId: 'open',
        callerMemberId: 'orch',
        callerConversationId: 'call-7',
        calleeMemberId: 'critic',
        mode: 'async',
        member: 2,
      },
    ]);
  });

  it('reads no pool member that is not a whole number from one', () => {
    const calls = openCalls([
      row('call_started', 'orch', {
        callId: 'a',
        callerNodeId: 'orch',
        calleeNodeId: 'critic',
        member: 0,
      }),
      row('call_started', 'orch', {
        callId: 'b',
        callerNodeId: 'orch',
        calleeNodeId: 'critic',
        member: 1.5,
      }),
      row('call_started', 'orch', {
        callId: 'c',
        callerNodeId: 'orch',
        calleeNodeId: 'critic',
        member: '2',
      }),
    ]);

    expect(calls.map((call) => call.member)).toEqual([null, null, null]);
  });

  it("names the member of a call's newest hand-off, and leaves other calls on their start's", () => {
    const calls = openCalls(
      [
        row('call_started', 'orch', {
          callId: 'moved',
          callerNodeId: 'orch',
          calleeNodeId: 'critic',
          member: 1,
        }),
        row('call_started', 'orch', {
          callId: 'stayed',
          callerNodeId: 'orch',
          calleeNodeId: 'critic',
          member: 1,
        }),
      ],
      [
        row('system', 'critic', { callId: 'moved', member: 2 }),
        row('system', 'critic', { callId: 'moved', member: 3 }),
        row('system', 'critic', { callId: 'elsewhere', member: 2 }),
      ],
    );

    expect(calls.map((call) => [call.callId, call.member])).toEqual([
      ['moved', 3],
      ['stayed', 1],
    ]);
  });
});

describe('OPEN_WORK_KINDS', () => {
  it('holds every kind the two folds read, so the boot reconcile loads nothing else', () => {
    const transcript = [
      row('status', 'a', { nodeId: 'a', status: 'running' }),
      row('call_started', 'a', {
        callId: 'c1',
        callerNodeId: 'a',
        calleeNodeId: 'b',
      }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c1' }),
      row('tool_call', 'b', { id: 't1', callId: 'c1' }),
      row('call_result', 'a', {
        callId: 'c1',
        callerNodeId: 'a',
        calleeNodeId: 'b',
      }),
      row('status', 'b', { nodeId: 'b', status: 'completed', callId: 'c1' }),
      row('call_started', 'a', {
        callId: 'c2',
        callerNodeId: 'a',
        calleeNodeId: 'b',
      }),
    ];
    const kinds: readonly string[] = OPEN_WORK_KINDS;
    const loaded = transcript.filter((item) => kinds.includes(item.kind));

    expect(openNodeTurns(loaded)).toEqual(openNodeTurns(transcript));
    expect(openCalls(loaded)).toEqual(openCalls(transcript));
    expect(openCalls(transcript).map((call) => call.callId)).toEqual(['c2']);
    expect(openNodeTurns(transcript)).toEqual([
      { memberId: 'a', callId: null },
    ]);
  });
});
