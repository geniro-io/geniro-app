import { describe, expect, it } from 'vitest';

import {
  mapClaudeMessage,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
} from './claude-message.utils';

/** A stream_event line as captured from a live claude-opus-5 turn. */
const textDelta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  },
});

/** A plain permission pause of the stdin control dialogue. */
const CONTROL_REQUEST =
  '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}}\n';

describe('mapClaudeMessage', () => {
  it('extracts the session id from system/init', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      }),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  it('harvests init slash_commands alongside the session id, dropping non-strings', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        slash_commands: ['review', 42, '', 'compact'],
      }),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'slash_commands', commands: ['review', 'compact'] },
    ]);
  });

  it('ignores non-init system events (hook_*, post_turn_summary)', () => {
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'hook_started' }),
    ).toEqual([]);
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'post_turn_summary' }),
    ).toEqual([]);
  });

  it('maps assistant text/thinking/tool_use blocks in order', () => {
    const events = mapClaudeMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  it('maps a user tool_result block', () => {
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'file body',
              is_error: false,
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: false,
      },
    ]);
  });

  it('maps a successful result to turn_complete with the usage readClaudeUsage derives', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        stop_reason: 'end_turn',
        usage: {
          // Turn-wide roll-up: three requests' worth of the same conversation.
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2_700,
          iterations: [
            {
              input_tokens: 4,
              output_tokens: 3,
              cache_creation_input_tokens: 12,
              cache_read_input_tokens: 996,
            },
          ],
        },
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 12,
            cacheReadInputTokens: 2_700,
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 0.14,
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          // The final request's prompt (4 + 12 + 996), not the 2_812 roll-up.
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          costUsd: 0.14,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
      },
    ]);
  });

  it('maps an error result to an error event', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        is_error: true,
        result: 'context limit exceeded',
      }),
    ).toEqual([{ type: 'error', message: 'context limit exceeded' }]);
  });

  it('ignores unknown event types and non-objects', () => {
    expect(mapClaudeMessage({ type: 'rate_limit_event', tier: 'x' })).toEqual(
      [],
    );
    expect(mapClaudeMessage('garbage')).toEqual([]);
    expect(mapClaudeMessage(null)).toEqual([]);
    expect(mapClaudeMessage(42)).toEqual([]);
  });
});

describe('mapClaudeMessage — the control dialogue (ask mode)', () => {
  it('maps a can_use_tool control_request to an approval_request event', () => {
    expect(mapClaudeMessage(JSON.parse(CONTROL_REQUEST))).toEqual([
      {
        type: 'approval_request',
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    ]);
  });

  it('carries requires_user_interaction — the question-vs-permission discriminator (M4)', () => {
    const events = mapClaudeMessage({
      type: 'control_request',
      request_id: 'req-q',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        requires_user_interaction: true,
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
      }),
    ]);
    // A plain permission carries no flag — the event must not fake one.
    const plain = mapClaudeMessage(JSON.parse(CONTROL_REQUEST));
    expect(
      (plain[0] as { requiresUserInteraction?: boolean })
        .requiresUserInteraction,
    ).toBeUndefined();
  });

  it('lifts message.usage off a REAL assistant line as live context', () => {
    // Captured verbatim from `claude -p --output-format stream-json --verbose`
    // on 2.1.220 (2026-07-29), trimmed to the fields under test. Fabricating
    // this line would pin our own guess about the CLI, not the CLI.
    const events = mapClaudeMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'A teapot.' }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 36569,
          cache_read_input_tokens: 18366,
          output_tokens: 1,
          service_tier: 'standard',
        },
      },
    });
    // Prompt side only — output tokens are not context — and cache traffic
    // counts, because on a resumed session it IS the context.
    expect(events).toEqual([
      { type: 'context_progress', contextTokens: 2 + 36569 + 18366 },
      { type: 'text', text: 'A teapot.' },
    ]);
  });

  it('emits no context event for an assistant line that carries no usage', () => {
    // A CLI build that omits it must degrade to "the meter waits", never to a
    // zero that reads as an empty context.
    expect(
      mapClaudeMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('returns an unmodelled control subtype as data instead of dropping it', () => {
    // The mapper is pure and cannot log, so the ONLY way an
    // unrecognized subtype becomes visible is by leaving the function. If this
    // ever goes back to `[]` the daemon is silently blind again.
    expect(
      mapClaudeMessage({
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'initialize' },
      }),
    ).toEqual([{ type: 'unhandled_control', subtype: 'initialize' }]);
  });

  it('reports a control_request with no readable subtype rather than swallowing it', () => {
    expect(
      mapClaudeMessage({ type: 'control_request', request_id: 'r' }),
    ).toEqual([{ type: 'unhandled_control', subtype: '<none>' }]);
  });
});

describe('mapClaudeStreamEvent', () => {
  it('lifts an assistant text increment', () => {
    expect(mapClaudeStreamEvent(textDelta('The sea'))).toEqual([
      { type: 'text_delta', text: 'The sea' },
    ]);
  });

  it('ignores a tool argument stream — a large Write would cross twice', () => {
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"content":"…' },
        },
      }),
    ).toEqual([]);
  });

  it('ignores a thinking increment — headless claude redacts the text', () => {
    // Captured verbatim: the body is empty and only a token estimate rides
    // along, so there is nothing to stream.
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: '',
            estimated_tokens: 150,
          },
        },
      }),
    ).toEqual([]);
  });

  it('ignores block and message framing', () => {
    for (const type of [
      'message_start',
      'message_delta',
      'message_stop',
      'content_block_start',
      'content_block_stop',
    ]) {
      expect(
        mapClaudeStreamEvent({ type: 'stream_event', event: { type } }),
      ).toEqual([]);
    }
  });

  it('survives a malformed or empty envelope rather than failing the turn', () => {
    expect(mapClaudeStreamEvent({ type: 'stream_event' })).toEqual([]);
    expect(
      mapClaudeStreamEvent({ type: 'stream_event', event: 'nope' }),
    ).toEqual([]);
    expect(mapClaudeStreamEvent(textDelta(''))).toEqual([]);
  });
});

describe('mapClaudeThinkingTokens', () => {
  it('reads the running reasoning total off the telemetry line', () => {
    // Captured verbatim from a live turn.
    expect(
      mapClaudeThinkingTokens({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 300,
        estimated_tokens_delta: 100,
      }),
    ).toEqual([{ type: 'thinking_progress', tokens: 300 }]);
  });

  it('reports nothing when there is no usable total', () => {
    expect(mapClaudeThinkingTokens({ type: 'system' })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 0 })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 'lots' })).toEqual([]);
  });
});
