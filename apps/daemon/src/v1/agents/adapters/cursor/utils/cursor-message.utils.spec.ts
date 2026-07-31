import { describe, expect, it } from 'vitest';

import { mapCursorMessage } from './cursor-message.utils';

describe('mapCursorMessage', () => {
  it('reads the session id from a system event under any known key', () => {
    expect(mapCursorMessage({ type: 'system', chatId: 'c-9' })).toEqual([
      { type: 'session', sessionId: 'c-9' },
    ]);
    expect(mapCursorMessage({ type: 'system', session_id: 's-9' })).toEqual([
      { type: 'session', sessionId: 's-9' },
    ]);
  });

  it('maps assistant nested content blocks', () => {
    expect(
      mapCursorMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('maps a flat assistant text shape', () => {
    expect(mapCursorMessage({ type: 'assistant', text: 'flat hi' })).toEqual([
      { type: 'text', text: 'flat hi' },
    ]);
  });

  it('surfaces a session id riding on a non-system event, then the payload', () => {
    expect(
      mapCursorMessage({ type: 'assistant', chat_id: 'c-1', text: 'yo' }),
    ).toEqual([
      { type: 'session', sessionId: 'c-1' },
      { type: 'text', text: 'yo' },
    ]);
  });

  it('maps a top-level tool_call', () => {
    expect(
      mapCursorMessage({
        type: 'tool_call',
        id: 't1',
        name: 'Bash',
        input: { cmd: 'ls' },
      }),
    ).toEqual([
      { type: 'tool_call', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
  });

  it('maps a successful result with a cost_usd variant', () => {
    expect(
      mapCursorMessage({
        type: 'result',
        is_error: false,
        cost_usd: 0.02,
        stop_reason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 5,
          outputTokens: 1,
          contextTokens: 5,
          contextWindowTokens: null,
          costUsd: 0.02,
        },
        stopReason: 'end_turn',
        finalText: null,
      },
    ]);
  });

  it('maps an error result', () => {
    expect(
      mapCursorMessage({
        type: 'result',
        is_error: true,
        error: 'rate limited',
      }),
    ).toEqual([{ type: 'error', message: 'rate limited' }]);
  });

  it('ignores unknown types and non-objects', () => {
    expect(mapCursorMessage({ type: 'heartbeat' })).toEqual([]);
    expect(mapCursorMessage(null)).toEqual([]);
    expect(mapCursorMessage([1, 2, 3])).toEqual([]);
  });

  it('degrades to a fresh session when a system event carries no recognized key', () => {
    // No session/chat/thread id under any known key → no session event, so the
    // turn starts fresh instead of resuming a bogus id.
    expect(mapCursorMessage({ type: 'system', subtype: 'init' })).toEqual([]);
  });
});
