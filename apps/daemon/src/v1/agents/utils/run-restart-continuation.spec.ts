import { describe, expect, it } from 'vitest';

import type {
  RestartContinuation,
  RestartContinuationCall,
  RestartContinuationMonitor,
} from '../chat.types';
import {
  isEmptyContinuation,
  mergeRestartContinuations,
  readRestartContinuation,
  restartContinuationColumn,
  restartContinuationPrompt,
} from './run-restart-continuation';

const call: RestartContinuationCall = {
  callId: 'call-3',
  callerMemberId: 'orch',
  callerConversationId: null,
  calleeMemberId: 'critic',
  conversationId: 'call-1',
  mode: 'async',
  sessionId: 'sess-1',
  member: 2,
};

const monitor: RestartContinuationMonitor = {
  memberId: 'agent',
  conversationId: null,
  id: 'm1',
  description: 'CI',
  command: 'npm run watch',
  remainingMs: 360_000,
};

const record: RestartContinuation = {
  cause: 'self-update',
  turns: [{ memberId: 'agent' }],
  calls: [call],
  monitors: [monitor],
};

describe('readRestartContinuation', () => {
  it('reads no column, an empty one, or one that is not JSON as no record', () => {
    expect(readRestartContinuation(null)).toBeNull();
    expect(readRestartContinuation('')).toBeNull();
    expect(readRestartContinuation('{not json')).toBeNull();
  });

  it.each(['quit', 'crash', 'unknown', 'mystery'])(
    'reads a record whose cause is %s as no record',
    (cause) => {
      expect(
        readRestartContinuation(
          JSON.stringify({
            cause,
            turns: [{ memberId: 'agent' }],
            calls: [],
            monitors: [],
          }),
        ),
      ).toBeNull();
    },
  );

  it('reads a record that owes nothing as no record', () => {
    expect(
      readRestartContinuation(
        JSON.stringify({
          cause: 'restart',
          turns: [],
          calls: [],
          monitors: [],
        }),
      ),
    ).toBeNull();
  });

  it('reads back every entry of a record as it was written', () => {
    expect(readRestartContinuation(JSON.stringify(record))).toEqual(record);
  });

  it('reads a record that owes only its monitors', () => {
    const monitorsOnly: RestartContinuation = {
      cause: 'restart',
      turns: [],
      calls: [],
      monitors: [monitor],
    };
    expect(readRestartContinuation(JSON.stringify(monitorsOnly))).toEqual(
      monitorsOnly,
    );
  });

  it('drops each entry that cannot say what it continues, and keeps the rest', () => {
    const json = JSON.stringify({
      cause: 'restart',
      turns: [{}, { memberId: 'agent' }],
      calls: [
        { ...call, callId: undefined },
        { ...call, mode: undefined },
        call,
      ],
      monitors: [
        { ...monitor, id: undefined },
        { ...monitor, description: undefined },
        monitor,
        'm9',
      ],
    });
    expect(readRestartContinuation(json)).toEqual({
      cause: 'restart',
      turns: [{ memberId: 'agent' }],
      calls: [call],
      monitors: [monitor],
    });
  });

  it('reads a pool member that is not a whole number of at least one as none', () => {
    const json = JSON.stringify({
      cause: 'restart',
      turns: [],
      calls: [
        { ...call, member: 0 },
        { ...call, callId: 'call-4', member: 1.5 },
        { ...call, callId: 'call-5', member: 'two' },
      ],
      monitors: [],
    });
    expect(readRestartContinuation(json)).toEqual({
      cause: 'restart',
      turns: [],
      calls: [
        { ...call, member: null },
        { ...call, callId: 'call-4', member: null },
        { ...call, callId: 'call-5', member: null },
      ],
      monitors: [],
    });
  });

  it('reads a time left that is negative or not a number as unknown', () => {
    const json = JSON.stringify({
      cause: 'restart',
      turns: [],
      calls: [],
      monitors: [
        { ...monitor, remainingMs: -5 },
        { ...monitor, id: 'm2', remainingMs: 'soon' },
      ],
    });
    expect(readRestartContinuation(json)).toEqual({
      cause: 'restart',
      turns: [],
      calls: [],
      monitors: [
        { ...monitor, remainingMs: null },
        { ...monitor, id: 'm2', remainingMs: null },
      ],
    });
  });

  it('reads the optional fields of a call and a monitor as absent when they are missing', () => {
    const json = JSON.stringify({
      cause: 'self-update',
      turns: [],
      calls: [
        {
          callId: 'call-3',
          callerMemberId: 'orch',
          calleeMemberId: 'critic',
          conversationId: 'call-1',
          mode: 'async',
        },
      ],
      monitors: [{ id: 'm1', description: 'CI' }],
    });
    expect(readRestartContinuation(json)).toEqual({
      cause: 'self-update',
      turns: [],
      calls: [
        {
          callId: 'call-3',
          callerMemberId: 'orch',
          callerConversationId: null,
          calleeMemberId: 'critic',
          conversationId: 'call-1',
          mode: 'async',
          sessionId: null,
          member: null,
        },
      ],
      monitors: [
        {
          memberId: null,
          conversationId: null,
          id: 'm1',
          description: 'CI',
          command: null,
          remainingMs: null,
        },
      ],
    });
  });
});

describe('restartContinuationColumn', () => {
  it('stores nothing for no record, or for one that owes nothing', () => {
    expect(restartContinuationColumn(null)).toBeNull();
    expect(
      restartContinuationColumn({
        cause: 'restart',
        turns: [],
        calls: [],
        monitors: [],
      }),
    ).toBeNull();
  });

  it('stores a record the reader gives back whole', () => {
    expect(readRestartContinuation(restartContinuationColumn(record))).toEqual(
      record,
    );
  });
});

describe('isEmptyContinuation', () => {
  const none: RestartContinuation = {
    cause: 'restart',
    turns: [],
    calls: [],
    monitors: [],
  };

  it('is true only when no turn, call or monitor is owed', () => {
    expect(isEmptyContinuation(none)).toBe(true);
    expect(
      isEmptyContinuation({ ...none, turns: [{ memberId: 'agent' }] }),
    ).toBe(false);
    expect(isEmptyContinuation({ ...none, calls: [call] })).toBe(false);
    expect(isEmptyContinuation({ ...none, monitors: [monitor] })).toBe(false);
  });
});

describe('mergeRestartContinuations', () => {
  it('returns the newer record as it is when no record came before it', () => {
    expect(mergeRestartContinuations(null, record)).toEqual(record);
  });

  it('joins two records once per entry, with the newer cause and the newer reading of an entry', () => {
    const older: RestartContinuation = {
      cause: 'self-update',
      turns: [{ memberId: 'agent' }, { memberId: 'writer' }],
      calls: [call],
      monitors: [monitor],
    };
    const newer: RestartContinuation = {
      cause: 'restart',
      turns: [{ memberId: 'agent' }],
      calls: [
        { ...call, sessionId: 'sess-2' },
        { ...call, callId: 'call-4' },
      ],
      monitors: [
        { ...monitor, remainingMs: 120_000 },
        { ...monitor, id: 'm2' },
      ],
    };

    expect(mergeRestartContinuations(older, newer)).toEqual({
      cause: 'restart',
      turns: [{ memberId: 'agent' }, { memberId: 'writer' }],
      calls: [
        { ...call, sessionId: 'sess-2' },
        { ...call, callId: 'call-4' },
      ],
      monitors: [
        { ...monitor, remainingMs: 120_000 },
        { ...monitor, id: 'm2' },
      ],
    });
  });
});

describe('restartContinuationPrompt', () => {
  it('says what stopped a conversation that was working, and that its session is intact', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'turn',
        calls: [],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were working. Your session is intact — check what is already done, then carry on.',
    );
  });

  it('asks a conversation working on a call to answer that call', () => {
    expect(
      restartContinuationPrompt('self-update', {
        working: 'call',
        calls: [],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The app was updated while you were working on this call. Your session is intact — check what is already done, then carry on and answer the call.',
    );
  });

  it('says what stopped a conversation that was waiting', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'idle',
        calls: [],
        monitors: [],
      }),
    ).toBe('[geniro] The daemon was restarted while you were waiting.');
  });

  it('names the one call that continues and says how to collect it', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'turn',
        calls: [{ callId: 'call-3', callee: 'critic' }],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were working. Your session is intact — check what is already done, then carry on. Still open: call-3 (critic) continues; collect it with await_agent(call-3).',
    );
  });

  it('names every call that continues and says to collect them all', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'turn',
        calls: [
          { callId: 'call-3', callee: 'critic' },
          { callId: 'call-4', callee: 'writer' },
        ],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were working. Your session is intact — check what is already done, then carry on. Still open: call-3 (critic), call-4 (writer) continue; collect them with await_agent.',
    );
  });

  it('names the monitors that were not started again, with their command and time left', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'idle',
        calls: [],
        monitors: [
          {
            id: 'm1',
            description: 'CI',
            command: 'npm test',
            remainingMs: 600_000,
          },
        ],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were waiting. Stopped monitors (not started again): m1 — CI — `npm test` (~10 min were left); start them again with monitor if you still need them.',
    );
  });
});
