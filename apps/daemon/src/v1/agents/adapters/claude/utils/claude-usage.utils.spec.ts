import { describe, expect, it } from 'vitest';

import {
  readClaudeAssistantContext,
  readClaudeUsage,
} from './claude-usage.utils';

/**
 * Verbatim `result.usage` of a real claude 2.1.220 turn that read six files
 * one tool call at a time. Its eight API requests each re-sent the whole
 * conversation, so the roll-up counts the same ~28k context seven times over;
 * `iterations` last entry is the final request, i.e. the context that existed.
 */
const SIX_TOOL_CALLS = {
  input_tokens: 14,
  cache_creation_input_tokens: 10_061,
  cache_read_input_tokens: 181_832,
  output_tokens: 863,
  iterations: [
    {
      input_tokens: 2,
      output_tokens: 5,
      cache_read_input_tokens: 28_123,
      cache_creation_input_tokens: 158,
      type: 'message',
    },
  ],
};

describe('readClaudeUsage', () => {
  it('reports the LAST request as context, not the turn-wide roll-up', () => {
    const usage = readClaudeUsage({
      usage: SIX_TOOL_CALLS,
      total_cost_usd: 0.213,
    });

    expect(usage.contextTokens).toBe(28_283); // 2 + 158 + 28_123
    // The roll-up sums to 191_907 — reporting THAT is the "ctx 2.8M / 200k"
    // bug, and it is the only other number derivable from this payload.
    expect(usage.contextTokens).not.toBe(191_907);
    // Billing figures stay turn-wide: they are what the turn actually spent.
    expect(usage.inputTokens).toBe(14);
    expect(usage.outputTokens).toBe(863);
    expect(usage.costUsd).toBe(0.213);
  });

  it('counts cache traffic — a resumed conversation is almost entirely cache-read', () => {
    // input_tokens alone would report 2 for a 28k conversation.
    const usage = readClaudeUsage({ usage: SIX_TOOL_CALLS });
    expect(usage.contextTokens).toBeGreaterThan(28_000);
  });

  it('takes the last iteration when a turn reports several', () => {
    const usage = readClaudeUsage({
      usage: {
        iterations: [
          { input_tokens: 1, cache_read_input_tokens: 5_000 },
          { input_tokens: 1, cache_read_input_tokens: 9_000 },
        ],
      },
    });
    expect(usage.contextTokens).toBe(9_001);
  });

  it('answers null — never the roll-up — when a build reports no iterations', () => {
    const usage = readClaudeUsage({
      usage: {
        input_tokens: 14,
        cache_creation_input_tokens: 10_061,
        cache_read_input_tokens: 181_832,
      },
    });
    // Unknown reads as "no ctx shown"; the roll-up would read as a wrong one.
    expect(usage.contextTokens).toBeNull();
    expect(usage.inputTokens).toBe(14);
  });

  it('reads the window of the model that ran the turn', () => {
    const usage = readClaudeUsage({
      usage: SIX_TOOL_CALLS,
      modelUsage: {
        'claude-opus-5[1m]': {
          inputTokens: 14,
          cacheReadInputTokens: 181_832,
          cacheCreationInputTokens: 10_061,
          contextWindow: 1_000_000,
        },
      },
    });
    expect(usage.contextWindowTokens).toBe(1_000_000);
  });

  it('picks the model that did the work, not a side-errand model', () => {
    // A turn can bill a small model for background chores; measuring the main
    // model's context against THAT model's window is the mis-scaling this
    // whole field exists to stop.
    const usage = readClaudeUsage({
      usage: SIX_TOOL_CALLS,
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: 300,
          cacheReadInputTokens: 0,
          contextWindow: 200_000,
        },
        'claude-opus-5[1m]': {
          inputTokens: 14,
          cacheReadInputTokens: 181_832,
          contextWindow: 1_000_000,
        },
      },
    });
    expect(usage.contextWindowTokens).toBe(1_000_000);
  });

  it('answers null for a window nobody reported', () => {
    expect(readClaudeUsage({ usage: SIX_TOOL_CALLS }).contextWindowTokens).toBe(
      null,
    );
    expect(
      readClaudeUsage({ usage: SIX_TOOL_CALLS, modelUsage: { m: { cost: 1 } } })
        .contextWindowTokens,
    ).toBeNull();
  });

  it('survives a result line with no usage at all', () => {
    expect(readClaudeUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      contextWindowTokens: null,
      costUsd: null,
    });
  });
});

describe('readClaudeAssistantContext', () => {
  it('sums the whole prompt side of ONE assistant line', () => {
    // Captured verbatim from a live 2.1.220 turn. Cache traffic counts: on a
    // resumed conversation the cache read IS almost the entire context, so
    // reading `input_tokens` alone would report 2 tokens for a 55k context.
    expect(
      readClaudeAssistantContext({
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 36_569,
          cache_read_input_tokens: 18_366,
          output_tokens: 1,
          service_tier: 'standard',
        },
      }),
    ).toBe(2 + 36_569 + 18_366);
  });

  it('counts no OUTPUT tokens — they are not context', () => {
    expect(
      readClaudeAssistantContext({
        usage: { input_tokens: 10, output_tokens: 5_000 },
      }),
    ).toBe(10);
  });

  it('answers null for a line that carries no usage, never zero', () => {
    // Null degrades to "the meter waits for the turn to finish"; a zero would
    // render as an emptied context on a conversation that has one.
    expect(readClaudeAssistantContext({})).toBeNull();
    expect(readClaudeAssistantContext({ usage: 'nope' })).toBeNull();
    expect(readClaudeAssistantContext({ usage: { service_tier: 'x' } })).toBe(
      null,
    );
  });
});
