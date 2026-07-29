import { describe, expect, it } from 'vitest';

import {
  helpAdvertisesPartialMessages,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
  PARTIAL_MESSAGES_FLAG,
} from './claude-live-stream';

/** A stream_event line as captured from a live claude-opus-5 turn. */
const textDelta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  },
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

describe('helpAdvertisesPartialMessages', () => {
  it('reads support off the binary that would reject the flag', () => {
    expect(
      helpAdvertisesPartialMessages(
        `  --verbose\n  ${PARTIAL_MESSAGES_FLAG}   Include partial message chunks\n`,
      ),
    ).toBe(true);
  });

  it('answers NO for an older CLI, so turns degrade to block streaming', () => {
    // The whole point of asking: passing the flag to a CLI that does not know
    // it fails every turn on argv, which is far worse than not streaming.
    expect(helpAdvertisesPartialMessages('  --verbose\n  --model\n')).toBe(
      false,
    );
  });

  it('answers NO when the binary could not be asked at all', () => {
    expect(helpAdvertisesPartialMessages(null)).toBe(false);
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
