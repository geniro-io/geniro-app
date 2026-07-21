import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import { mapEventToItem, terminalStatus } from './event-to-item';

// The one event→transcript projection BOTH execution paths (chat service and
// graph executor) persist through — each arm is pinned with a worked-example
// literal so a payload-field regression (e.g. isError dropped) fails here even
// though the adapter specs only cover CLI-line→AgentEvent.
describe('mapEventToItem', () => {
  it('drops session events — captured into node_state, never the transcript', () => {
    expect(mapEventToItem({ type: 'session', sessionId: 's1' })).toBeNull();
  });

  it('drops slash_commands reports — skill-harvest store, never the transcript', () => {
    expect(
      mapEventToItem({ type: 'slash_commands', commands: ['review'] }),
    ).toBeNull();
  });

  it('maps text to an assistant message row', () => {
    expect(mapEventToItem({ type: 'text', text: 'hello there' })).toEqual({
      kind: 'message',
      role: 'assistant',
      payload: { text: 'hello there' },
    });
  });

  it('maps reasoning to an assistant reasoning row', () => {
    expect(mapEventToItem({ type: 'reasoning', text: 'let me think' })).toEqual(
      {
        kind: 'reasoning',
        role: 'assistant',
        payload: { text: 'let me think' },
      },
    );
  });

  it('maps tool_call keeping id, name, and input intact', () => {
    expect(
      mapEventToItem({
        type: 'tool_call',
        id: 't1',
        name: 'Read',
        input: { path: '/x' },
      }),
    ).toEqual({
      kind: 'tool_call',
      role: 'assistant',
      payload: { id: 't1', name: 'Read', input: { path: '/x' } },
    });
  });

  it('maps tool_result keeping id, name, result, and isError intact', () => {
    expect(
      mapEventToItem({
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: true,
      }),
    ).toEqual({
      kind: 'tool_result',
      role: 'tool',
      payload: { id: 't1', name: null, result: 'file body', isError: true },
    });
  });

  it('maps approval_request with no flag key when requiresUserInteraction is unset', () => {
    const mapped = mapEventToItem({
      type: 'approval_request',
      id: 'req-1',
      toolName: 'Write',
      input: { file_path: 'a.txt' },
    });
    expect(mapped).toEqual({
      kind: 'approval_request',
      role: null,
      payload: {
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    });
    // A plain permission must not fake the question discriminator — the key is
    // absent, not merely undefined.
    expect(
      'requiresUserInteraction' in (mapped!.payload as Record<string, unknown>),
    ).toBe(false);
  });

  it('maps a flagged approval_request carrying requiresUserInteraction: true', () => {
    expect(
      mapEventToItem({
        type: 'approval_request',
        id: 'req-q',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      }),
    ).toEqual({
      kind: 'approval_request',
      role: null,
      payload: {
        id: 'req-q',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      },
    });
  });

  it('maps turn_complete keeping usage and stopReason; finalText is not persisted', () => {
    expect(
      mapEventToItem({
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          contextTokens: 1012,
          costUsd: 0.14,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
      }),
    ).toEqual({
      kind: 'turn_complete',
      role: null,
      payload: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          contextTokens: 1012,
          costUsd: 0.14,
        },
        stopReason: 'end_turn',
      },
    });
  });

  it('maps turn_cancelled to an empty payload', () => {
    expect(mapEventToItem({ type: 'turn_cancelled' })).toEqual({
      kind: 'turn_cancelled',
      role: null,
      payload: {},
    });
  });

  it('maps error keeping the message', () => {
    expect(mapEventToItem({ type: 'error', message: 'boom' })).toEqual({
      kind: 'error',
      role: null,
      payload: { message: 'boom' },
    });
  });
});

describe('terminalStatus', () => {
  it('maps each terminal event to its run status', () => {
    expect(
      terminalStatus({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      }),
    ).toBe('completed');
    expect(terminalStatus({ type: 'error', message: 'boom' })).toBe('failed');
    expect(terminalStatus({ type: 'turn_cancelled' })).toBe('cancelled');
  });

  it('returns null for every mid-turn event', () => {
    const midTurn: AgentEvent[] = [
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'hm' },
      { type: 'tool_call', id: 't1', name: 'Read', input: null },
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: null,
        isError: false,
      },
      { type: 'session', sessionId: 's1' },
      { type: 'slash_commands', commands: ['review'] },
      { type: 'approval_request', id: 'req-1', toolName: 'Write', input: null },
    ];
    for (const event of midTurn) {
      expect(terminalStatus(event)).toBeNull();
    }
  });
});
