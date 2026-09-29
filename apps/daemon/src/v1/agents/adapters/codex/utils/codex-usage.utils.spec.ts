import { describe, expect, it } from 'vitest';

import { baselineOf, readTokenUsage, turnUsageOf } from './codex-usage.utils';

/**
 * Shapes transcribed from a live `thread/tokenUsage/updated` on codex 0.157.1
 * (a `gpt-5.5` turn, then the reading right after `thread/compact/start`).
 */
const breakdown = (
  total: number,
  input: number,
  cached: number,
  output: number,
  reasoning = 0,
) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});

describe('readTokenUsage', () => {
  it('reads the running total, the last request and the window', () => {
    const usage = readTokenUsage({
      threadId: 't',
      turnId: 'u',
      tokenUsage: {
        total: breakdown(16990, 16969, 8064, 21, 14),
        last: breakdown(16990, 16969, 8064, 21, 14),
        modelContextWindow: 258400,
      },
    });
    expect(usage?.total.totalTokens).toBe(16990);
    expect(usage?.last.cachedInputTokens).toBe(8064);
    expect(usage?.modelContextWindow).toBe(258400);
  });

  it('answers null when a required figure is missing, never a partial reading', () => {
    expect(
      readTokenUsage({
        tokenUsage: { total: { totalTokens: 1 }, last: breakdown(1, 1, 0, 0) },
      }),
    ).toBeNull();
  });

  it('treats an absent or non-positive window as unknown', () => {
    const usage = readTokenUsage({
      tokenUsage: {
        total: breakdown(10, 8, 0, 2),
        last: breakdown(10, 8, 0, 2),
        modelContextWindow: 0,
      },
    });
    expect(usage?.modelContextWindow).toBeNull();
  });
});

describe('baselineOf', () => {
  it('recovers the total BEFORE the turn from its first reading', () => {
    // A resumed thread: the first reading's total already holds every earlier
    // turn. Subtracting that request's own figures is what makes the turn's
    // usage its own rather than the whole thread's.
    const first = readTokenUsage({
      tokenUsage: {
        total: breakdown(50_000, 49_000, 30_000, 1_000),
        last: breakdown(16_000, 15_900, 8_000, 100),
        modelContextWindow: 258400,
      },
    })!;
    expect(baselineOf(first)).toEqual(breakdown(34_000, 33_100, 22_000, 900));
  });
});

describe('turnUsageOf', () => {
  it('bills the turn its delta, with input net of cached tokens', () => {
    const latest = readTokenUsage({
      tokenUsage: {
        total: breakdown(40_000, 38_000, 20_000, 2_000, 300),
        last: breakdown(19_000, 18_500, 10_000, 500, 100),
        modelContextWindow: 258400,
      },
    });
    const usage = turnUsageOf({
      latest,
      baseline: breakdown(20_000, 19_000, 9_000, 1_000, 100),
      model: 'gpt-5.5',
      durationMs: 8316,
    });
    // input delta 19,000 of which 11,000 were cache reads.
    expect(usage.inputTokens).toBe(8_000);
    expect(usage.cacheReadTokens).toBe(11_000);
    expect(usage.outputTokens).toBe(1_000);
    expect(usage.thinkingTokens).toBe(200);
    // The window holds what the LAST request carried, not the thread's sum.
    expect(usage.contextTokens).toBe(19_000);
    expect(usage.contextWindowTokens).toBe(258400);
    expect(usage.contextModel).toBe('gpt-5.5');
    expect(usage.durationMs).toBe(8316);
    // codex prices nothing on its wire.
    expect(usage.costUsd).toBeNull();
  });

  it('reports no token figures, rather than zeros, when nothing was measured', () => {
    const usage = turnUsageOf({
      latest: null,
      baseline: null,
      model: 'gpt-5.5',
      durationMs: null,
    });
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.contextTokens).toBeNull();
    expect(usage.contextModel).toBeNull();
  });
});
