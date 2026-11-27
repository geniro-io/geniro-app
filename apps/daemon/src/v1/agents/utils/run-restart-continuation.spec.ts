import { describe, expect, it } from 'vitest';

import type {
  RestartContinuation,
  RestartContinuationCall,
  RestartContinuationFailedCall,
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

const failed: RestartContinuationFailedCall = {
  callId: 'call-2',
  callerMemberId: 'orch',
  callerConversationId: null,
  calleeMemberId: 'writer',
  again: true,
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
  held: false,
  turns: [{ memberId: 'agent' }],
  calls: [call],
  failedCalls: [failed],
  monitors: [monitor],
};

describe('readRestartContinuation', () => {
  it('reads no column, an empty one, or one that is not JSON as no record', () => {
    expect(readRestartContinuation(null)).toBeNull();
    expect(readRestartContinuation('')).toBeNull();
    expect(readRestartContinuation('{not json')).toBeNull();
  });

  it.each(['mystery', '', 7])(
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

  it.each(['quit', 'self-update', 'restart', 'crash', 'unknown'] as const)(
    'reads a record cut off by a %s with whether it waits for the user as written',
    (cause) => {
      for (const held of [true, false]) {
        expect(
          readRestartContinuation(
            JSON.stringify({ cause, held, turns: [{ memberId: 'agent' }] }),
          ),
        ).toMatchObject({ cause, held });
      }
    },
  );

  it('reads a record that does not say it waits as one that does not', () => {
    expect(
      readRestartContinuation(
        JSON.stringify({ cause: 'crash', turns: [{ memberId: 'agent' }] }),
      ),
    ).toMatchObject({ held: false });
  });

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
      held: false,
      turns: [],
      calls: [],
      failedCalls: [],
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
      held: false,
      turns: [{ memberId: 'agent' }],
      calls: [call],
      failedCalls: [],
      monitors: [monitor],
    });
  });

  it('drops a failed call that cannot name its caller or callee, and reads a missing again as false', () => {
    const json = JSON.stringify({
      cause: 'restart',
      turns: [],
      calls: [],
      failedCalls: [
        { ...failed, callerMemberId: undefined },
        { ...failed, calleeMemberId: undefined },
        { callId: 'call-7', callerMemberId: 'orch', calleeMemberId: 'poet' },
      ],
      monitors: [],
    });
    expect(readRestartContinuation(json)).toEqual({
      cause: 'restart',
      held: false,
      turns: [],
      calls: [],
      failedCalls: [
        {
          callId: 'call-7',
          callerMemberId: 'orch',
          callerConversationId: null,
          calleeMemberId: 'poet',
          again: false,
        },
      ],
      monitors: [],
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
      held: false,
      turns: [],
      calls: [
        { ...call, member: null },
        { ...call, callId: 'call-4', member: null },
        { ...call, callId: 'call-5', member: null },
      ],
      failedCalls: [],
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
      held: false,
      turns: [],
      calls: [],
      failedCalls: [],
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
      held: false,
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
      failedCalls: [],
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
        held: false,
        turns: [],
        calls: [],
        failedCalls: [],
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
    held: false,
    turns: [],
    calls: [],
    failedCalls: [],
    monitors: [],
  };

  it('is true only when no turn, call or monitor is owed', () => {
    expect(isEmptyContinuation(none)).toBe(true);
    expect(
      isEmptyContinuation({ ...none, turns: [{ memberId: 'agent' }] }),
    ).toBe(false);
    expect(isEmptyContinuation({ ...none, calls: [call] })).toBe(false);
    expect(isEmptyContinuation({ ...none, failedCalls: [failed] })).toBe(false);
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
      held: false,
      turns: [{ memberId: 'agent' }, { memberId: 'writer' }],
      calls: [call],
      failedCalls: [],
      monitors: [monitor],
    };
    const newer: RestartContinuation = {
      cause: 'restart',
      held: false,
      turns: [{ memberId: 'agent' }],
      calls: [
        { ...call, sessionId: 'sess-2' },
        { ...call, callId: 'call-4' },
      ],
      failedCalls: [],
      monitors: [
        { ...monitor, remainingMs: 120_000 },
        { ...monitor, id: 'm2' },
      ],
    };

    expect(mergeRestartContinuations(older, newer)).toEqual({
      cause: 'restart',
      held: false,
      turns: [{ memberId: 'agent' }, { memberId: 'writer' }],
      calls: [
        { ...call, sessionId: 'sess-2' },
        { ...call, callId: 'call-4' },
      ],
      failedCalls: [],
      monitors: [
        { ...monitor, remainingMs: 120_000 },
        { ...monitor, id: 'm2' },
      ],
    });
  });
});

describe('mergeRestartContinuations of a held record', () => {
  const heldRecord: RestartContinuation = {
    cause: 'unknown',
    held: true,
    turns: [{ memberId: 'agent' }],
    calls: [],
    failedCalls: [],
    monitors: [],
  };

  it('keeps a crash record waiting, under its cause, when a later quit adds to it', () => {
    const merged = mergeRestartContinuations(heldRecord, {
      ...heldRecord,
      cause: 'quit',
      held: false,
      turns: [{ memberId: 'critic' }],
    });
    expect(merged).toMatchObject({ cause: 'unknown', held: true });
    expect(merged.turns).toEqual([
      { memberId: 'agent' },
      { memberId: 'critic' },
    ]);
  });

  it('makes a continuing record wait once a crash adds to it', () => {
    expect(
      mergeRestartContinuations(
        { ...heldRecord, cause: 'quit', held: false },
        heldRecord,
      ),
    ).toMatchObject({ cause: 'unknown', held: true });
  });
});

describe('mergeRestartContinuations with failed calls', () => {
  it('keeps a call the newer boot failed out of the calls that continue', () => {
    const older: RestartContinuation = {
      cause: 'restart',
      held: false,
      turns: [],
      calls: [call],
      failedCalls: [],
      monitors: [],
    };
    const newer: RestartContinuation = {
      cause: 'restart',
      held: false,
      turns: [],
      calls: [],
      failedCalls: [{ ...failed, callId: 'call-3' }],
      monitors: [],
    };
    const merged = mergeRestartContinuations(older, newer);
    expect(merged.calls).toEqual([]);
    expect(merged.failedCalls).toEqual([{ ...failed, callId: 'call-3' }]);
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
      '[geniro] The daemon was restarted while you were working. That stop was geniro\'s, not the user\'s: a "user doesn\'t want to proceed" or "stop and wait" note it left in your transcript does not apply. Your session is intact — check what is already done, run the interrupted command again, then carry on.',
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
      '[geniro] The app was updated while you were working on this call. That stop was geniro\'s, not the user\'s: a "user doesn\'t want to proceed" or "stop and wait" note it left in your transcript does not apply. Your session is intact — check what is already done, run the interrupted command again, then carry on and answer the call.',
    );
  });

  it("tells a conversation that was working that the CLI's stop-and-wait note was geniro's, and to run the interrupted command again", () => {
    const prompt = restartContinuationPrompt('self-update', {
      working: 'turn',
      fresh: true,
      calls: [],
      monitors: [],
    });
    expect(prompt).toContain("That stop was geniro's, not the user's");
    expect(prompt).toContain('does not apply');
    expect(prompt).toContain(
      'Check what is already done, run the interrupted command again',
    );
  });

  it('names a call the boot failed and asks to take it over', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'idle',
        calls: [],
        failedCalls: [{ callId: 'call-2', callee: 'writer', again: true }],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were waiting. Failed and not continued: call-2 (writer) — the daemon stopped again while it was being continued after an earlier restart. Its work is unfinished — take it over or call again.',
    );
  });

  it('names every call the boot failed, each with its reason', () => {
    expect(
      restartContinuationPrompt('restart', {
        working: 'idle',
        calls: [],
        failedCalls: [
          { callId: 'call-2', callee: 'writer', again: true },
          { callId: 'call-5', callee: 'critic', again: false },
        ],
        monitors: [],
      }),
    ).toBe(
      '[geniro] The daemon was restarted while you were waiting. Failed and not continued: call-2 (writer) — the daemon stopped again while it was being continued after an earlier restart; call-5 (critic) — it could not be continued. Their work is unfinished — take it over or call again.',
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
      '[geniro] The daemon was restarted while you were working. That stop was geniro\'s, not the user\'s: a "user doesn\'t want to proceed" or "stop and wait" note it left in your transcript does not apply. Your session is intact — check what is already done, run the interrupted command again, then carry on. Still open: call-3 (critic) continues; collect it with await_agent(call-3).',
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
      '[geniro] The daemon was restarted while you were working. That stop was geniro\'s, not the user\'s: a "user doesn\'t want to proceed" or "stop and wait" note it left in your transcript does not apply. Your session is intact — check what is already done, run the interrupted command again, then carry on. Still open: call-3 (critic), call-4 (writer) continue; collect them with await_agent.',
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
