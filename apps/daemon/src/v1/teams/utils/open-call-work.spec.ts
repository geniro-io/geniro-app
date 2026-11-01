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
        calleeMemberId: 'critic',
        mode: 'async',
      },
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
