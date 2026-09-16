import { describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import { openCalls, openNodeTurns } from './open-call-work';

let seq = 0;
function row(kind: string, nodeId: string | null, payload: unknown): Item {
  seq += 1;
  return { seq, kind, nodeId, payload: JSON.stringify(payload) } as Item;
}

describe('openNodeTurns', () => {
  it('pairs running rows with terminal ones per node and call', () => {
    const turns = openNodeTurns([
      row('status', 'a', { nodeId: 'a', status: 'running' }),
      row('status', 'a', { nodeId: 'a', status: 'completed' }),
      row('status', 'a', { nodeId: 'a', status: 'running' }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c1' }),
      row('status', 'b', { nodeId: 'b', status: 'running', callId: 'c2' }),
      row('status', 'b', { nodeId: 'b', status: 'failed', callId: 'c2' }),
    ]);

    expect(turns).toEqual([
      { nodeId: 'a', callId: null },
      { nodeId: 'b', callId: 'c1' },
    ]);
  });

  it('never lets a start-less terminal row settle a later turn', () => {
    const turns = openNodeTurns([
      row('status', 'a', { nodeId: 'a', status: 'skipped' }),
      row('status', 'a', { nodeId: 'a', status: 'running' }),
    ]);

    expect(turns).toEqual([{ nodeId: 'a', callId: null }]);
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
        callerNodeId: 'orch',
        calleeNodeId: 'critic',
        mode: 'async',
      },
    ]);
  });
});
