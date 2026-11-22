import { describe, expect, it } from 'vitest';

import { runSampleOf } from './run-sample';

describe('runSampleOf', () => {
  it('sums what the reflection and its check reported and names the model charged most', () => {
    expect(
      runSampleOf([
        { model: 'claude-haiku-5-5', costUsd: 0.1, durationMs: 20_000 },
        { model: 'claude-sonnet-5-5', costUsd: 0.3, durationMs: 10_000 },
        { model: 'claude-haiku-5-5', costUsd: 0.05, durationMs: null },
      ]),
    ).toEqual({ model: 'claude-sonnet-5-5', usd: 0.45, durationMs: 30_000 });
  });

  it('answers null for what no row reported, never 0', () => {
    expect(
      runSampleOf([{ model: 'grok-4.7', costUsd: null, durationMs: null }]),
    ).toEqual({ model: 'grok-4.7', usd: null, durationMs: null });
    expect(runSampleOf([])).toEqual({
      model: null,
      usd: null,
      durationMs: null,
    });
  });
});
