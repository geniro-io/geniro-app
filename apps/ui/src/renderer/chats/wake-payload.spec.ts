import { describe, expect, it } from 'vitest';

import { readWakeNotice } from './wake-payload';

describe('readWakeNotice', () => {
  it('reads the calls a wake notice names, by callee name and reason', () => {
    expect(
      readWakeNotice({
        message:
          'Picked back up — Ada asked a question in call-1; Peter finished call-2.',
        wake: [
          { callId: 'call-1', callee: 'Ada', reason: 'asked' },
          { callId: 'call-2', callee: 'Peter', reason: 'finished' },
        ],
      }),
    ).toEqual([
      { callId: 'call-1', callee: 'Ada', reason: 'asked' },
      { callId: 'call-2', callee: 'Peter', reason: 'finished' },
    ]);
  });

  it('carries the optional fields a wake entry holds when they are valid', () => {
    expect(
      readWakeNotice({
        wake: [
          {
            callId: 'call-3',
            callee: 'Ada',
            reason: 'finished',
            calleeNodeId: 'node-ada',
            status: 'cancelled',
            result: 'stopped early',
          },
          {
            callId: 'call-4',
            callee: 'Peter',
            reason: 'asked',
            question: 'Which?',
            options: ['A', 2],
          },
        ],
      }),
    ).toEqual([
      {
        callId: 'call-3',
        callee: 'Ada',
        reason: 'finished',
        calleeNodeId: 'node-ada',
        status: 'cancelled',
        result: 'stopped early',
      },
      {
        callId: 'call-4',
        callee: 'Peter',
        reason: 'asked',
        question: 'Which?',
        options: ['A'],
      },
    ]);
  });

  it('drops an optional field whose value is not of its type', () => {
    expect(
      readWakeNotice({
        wake: [
          {
            callId: 'call-5',
            callee: 'Ada',
            reason: 'finished',
            calleeNodeId: 7,
            status: 'running',
            result: null,
          },
        ],
      }),
    ).toEqual([{ callId: 'call-5', callee: 'Ada', reason: 'finished' }]);
  });

  it('skips malformed entries and keeps the valid ones', () => {
    expect(
      readWakeNotice({
        wake: [
          null,
          { callId: '', callee: 'Ada', reason: 'asked' },
          { callId: 'call-6', callee: 'Ada', reason: 'sleeping' },
          { callId: 'call-7', callee: 'Peter', reason: 'finished' },
        ],
      }),
    ).toEqual([{ callId: 'call-7', callee: 'Peter', reason: 'finished' }]);
  });

  it('answers null when there is no usable wake list', () => {
    expect(readWakeNotice(null)).toBeNull();
    expect(readWakeNotice({ message: 'Picked back up.' })).toBeNull();
    expect(readWakeNotice({ wake: [] })).toBeNull();
    expect(
      readWakeNotice({
        wake: [{ callId: '', callee: 'Ada', reason: 'asked' }],
      }),
    ).toBeNull();
  });
});
