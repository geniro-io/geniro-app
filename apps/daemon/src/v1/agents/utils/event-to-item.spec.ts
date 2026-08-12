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

  it('drops text deltas — the live plane must NEVER become a database row', () => {
    // A turn emits hundreds of these. The durable record is the `text` event
    // that follows; if this ever returned a row, every token would be written
    // and replayed.
    expect(mapEventToItem({ type: 'text_delta', text: 'The sea' })).toBeNull();
  });

  it('drops thinking progress — a turn reports it repeatedly', () => {
    expect(
      mapEventToItem({ type: 'thinking_progress', tokens: 300 }),
    ).toBeNull();
  });

  it('drops a compaction boundary — housekeeping, not a line in the conversation', () => {
    // Asserted because the default is the opposite: `notice` DOES become a
    // `system` row, so mapping compaction that way is the obvious mistake, and
    // it would wedge a permanent "compacted" line between the user's messages.
    // The event is announced as momentary activity instead.
    expect(
      mapEventToItem({
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'auto',
        preTokens: 180_000,
        postTokens: 32_000,
      }),
    ).toBeNull();
  });

  it('drops the START of a compaction too — both ends are momentary', () => {
    // The `started` phase is newer than the arm's original decision, so it needs
    // its own assertion: an in-progress marker is even less of a transcript line
    // than the finished one, and it must not become a row that then sits there
    // claiming a compaction is still running.
    expect(
      mapEventToItem({
        type: 'context_compacted',
        phase: 'started',
        trigger: null,
        preTokens: null,
        postTokens: null,
      }),
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
          contextWindowTokens: 1_000_000,
          contextModel: 'claude-sonnet-4-5',
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
          contextWindowTokens: 1_000_000,
          contextModel: 'claude-sonnet-4-5',
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

  it('maps an adapter notice to a system item, like an executor-level degrade', () => {
    expect(
      mapEventToItem({ type: 'notice', message: 'agent calls disabled' }),
    ).toEqual({
      kind: 'system',
      role: null,
      // No `origin` key AT ALL for a daemon-authored notice — asserted with
      // toEqual rather than toMatchObject precisely so an unconditional
      // `origin: undefined` would fail. Every pre-existing notice must keep the
      // byte-identical payload it had before `origin` existed.
      payload: { message: 'agent calls disabled' },
    });
  });

  it('stamps `origin` on a notice the CLI authored, so the row can attribute it', () => {
    // The renderer reads this key back (`chats/system-payload.ts`) to decide
    // whether the row is the daemon speaking or the CLI being relayed. Drop the
    // stamp and a relayed compaction summary renders in the daemon's own failure
    // chrome — red, captioned "system" — as though geniro were reporting a fault.
    expect(
      mapEventToItem({
        type: 'notice',
        message: 'This session is being continued…',
        origin: 'cli',
      }),
    ).toEqual({
      kind: 'system',
      role: null,
      payload: { message: 'This session is being continued…', origin: 'cli' },
    });
  });
});

describe('mapEventToItem — sub-agent origin', () => {
  const SUB = 'toolu_01GffB3XLs9hgFTpZLrsex4f';

  it('stamps the origin onto the payload the renderer reads', () => {
    // TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads this
    // exact key off the payload. The payload is `z.unknown()` on the wire, so
    // no generated type ties the two sides together — this literal is the
    // contract, and renaming the key here without renaming it there silently
    // returns the transcript to one interleaved flat run.
    expect(
      mapEventToItem({
        type: 'tool_call',
        id: 't1',
        name: 'Bash',
        input: { command: 'echo hi' },
        parentToolUseId: SUB,
      }),
    ).toEqual({
      kind: 'tool_call',
      role: 'assistant',
      payload: {
        id: 't1',
        name: 'Bash',
        input: { command: 'echo hi' },
        parentToolUseId: SUB,
      },
    });
  });

  it('adds NO key at all for main-thread work', () => {
    // The common case by a wide margin, and every row of it is a database
    // write: an always-present `parentToolUseId: null` would cost a field on
    // every row to say nothing.
    const item = mapEventToItem({
      type: 'tool_call',
      id: 't1',
      name: 'Bash',
      input: null,
    });
    expect(item?.payload).not.toHaveProperty('parentToolUseId');
  });

  it('does not resurrect an ephemeral event just because it has an origin', () => {
    // The ephemeral plane is never a database row, origin or not.
    expect(
      mapEventToItem({
        type: 'context_progress',
        contextTokens: 10,
        parentToolUseId: SUB,
      }),
    ).toBeNull();
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
      { type: 'notice', message: 'a degrade, not the end of the turn' },
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
