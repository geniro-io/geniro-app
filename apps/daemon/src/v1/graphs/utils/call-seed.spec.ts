import { describe, expect, it } from 'vitest';

import { callConversation, callNumber, readCallSeed } from './call-seed';

describe('callNumber', () => {
  it('reads the number out of a broker call id and nothing else', () => {
    expect(callNumber('call-7')).toBe(7);
    expect(callNumber('call-12')).toBe(12);
    expect(callNumber('call-')).toBeNull();
    expect(callNumber('call-x')).toBeNull();
    expect(callNumber('7')).toBeNull();
    expect(callNumber('xcall-7')).toBeNull();
  });
});

describe('readCallSeed', () => {
  it('continues the counter past the highest id and files each callee session onto its call', () => {
    const seed = readCallSeed([
      {
        kind: 'call_started',
        payload: {
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          mode: 'async',
        },
      },
      {
        kind: 'call_result',
        payload: {
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          sessionId: 'sess-1',
          status: 'ok',
        },
      },
      {
        kind: 'call_started',
        payload: {
          callId: 'call-3',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          thread: 'call-1',
        },
      },
      {
        kind: 'call_result',
        payload: {
          callId: 'call-3',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          sessionId: 'sess-1',
          status: 'ok',
        },
      },
    ]);
    expect(seed.callSeq).toBe(3);
    expect(seed.records).toEqual([
      {
        callId: 'call-1',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        thread: null,
        sessionId: 'sess-1',
      },
      {
        callId: 'call-3',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        thread: 'call-1',
        sessionId: 'sess-1',
      },
    ]);
  });

  it('keeps a call the earlier daemon died inside: its id is spent, its session is not resumable', () => {
    const seed = readCallSeed([
      {
        kind: 'call_started',
        payload: {
          callId: 'call-2',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
        },
      },
    ]);
    expect(seed.callSeq).toBe(2);
    expect(seed.records).toEqual([
      {
        callId: 'call-2',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        thread: null,
        sessionId: null,
      },
    ]);
  });

  it('reads a result whose start is missing as a settled call, and a null session as not resumable', () => {
    const seed = readCallSeed([
      {
        kind: 'call_result',
        payload: {
          callId: 'call-4',
          callerNodeId: 'orch',
          calleeNodeId: 'writer',
          sessionId: null,
          status: 'error',
          error: 'CALLEE_FAILED',
        },
      },
    ]);
    expect(seed).toEqual({
      callSeq: 4,
      records: [
        {
          callId: 'call-4',
          callerNodeId: 'orch',
          calleeNodeId: 'writer',
          thread: null,
          sessionId: null,
        },
      ],
    });
  });

  it('skips rows that do not name a call and its two parties, and non-object payloads', () => {
    const seed = readCallSeed([
      { kind: 'call_started', payload: null },
      { kind: 'call_started', payload: 'call-9' },
      { kind: 'call_started', payload: { callId: 'call-9' } },
      {
        kind: 'call_started',
        payload: { callId: '', callerNodeId: 'orch', calleeNodeId: 'helper' },
      },
      {
        kind: 'message',
        payload: { callId: 'call-8', callerNodeId: 'o', calleeNodeId: 'h' },
      },
    ]);
    expect(seed).toEqual({ callSeq: 8, records: [] });
  });

  it('reads the payload column as it is stored — JSON text — as well as the object it was written from', () => {
    // `persistItemAndEmit` writes `JSON.stringify(payload)` into the column,
    // so the real DAO hands back strings; an object-holding row must read the
    // same, or a fake passes where the daemon fails.
    const seed = readCallSeed([
      {
        kind: 'call_started',
        payload: JSON.stringify({
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
        }),
      },
      {
        kind: 'call_result',
        payload: JSON.stringify({
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          sessionId: 'sess-1',
        }),
      },
      { kind: 'call_started', payload: '{not json' },
    ]);
    expect(seed).toEqual({
      callSeq: 1,
      records: [
        {
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          thread: null,
          sessionId: 'sess-1',
        },
      ],
    });
  });

  it('is empty for a run that never called anyone', () => {
    expect(readCallSeed([])).toEqual({ callSeq: 0, records: [] });
  });
});

describe('callConversation', () => {
  const record = (
    callId: string,
    calleeNodeId: string,
    thread: string | null,
    sessionId: string | null,
  ) => ({ callId, callerNodeId: 'manager', calleeNodeId, thread, sessionId });

  it('walks a continuation back to the call that opened its conversation', () => {
    const records = [
      record('call-1', 'engineer', null, 'sess-a'),
      record('call-2', 'researcher', null, 'sess-r'),
      record('call-3', 'engineer', 'call-1', 'sess-b'),
      record('call-4', 'engineer', 'call-3', null),
    ];

    expect(callConversation(records, 'call-4')).toEqual({
      conversationId: 'call-1',
      calleeNodeId: 'engineer',
      callIds: ['call-1', 'call-3', 'call-4'],
      // The newest session any call of it recorded — call-4 settled without one.
      sessionId: 'sess-b',
    });
    expect(callConversation(records, 'call-2')).toEqual({
      conversationId: 'call-2',
      calleeNodeId: 'researcher',
      callIds: ['call-2'],
      sessionId: 'sess-r',
    });
  });

  it('opens a conversation of its own for a thread naming a call it does not hold', () => {
    const records = [record('call-9', 'engineer', 'call-3', 'sess-x')];

    expect(callConversation(records, 'call-9')?.conversationId).toBe('call-9');
  });

  it('answers null for a call the records do not hold', () => {
    expect(
      callConversation([record('call-1', 'engineer', null, null)], 'call-7'),
    ).toBeNull();
  });
});
