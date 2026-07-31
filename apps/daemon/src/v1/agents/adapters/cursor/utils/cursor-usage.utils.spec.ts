import { describe, expect, it } from 'vitest';

import { readCursorUsage } from './cursor-usage.utils';

describe('readCursorUsage', () => {
  it('reads the snake_case spelling of every field', () => {
    expect(
      readCursorUsage({
        usage: { input_tokens: 120, output_tokens: 34 },
        total_cost_usd: 0.011,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      contextTokens: 120,
      contextWindowTokens: null,
      costUsd: 0.011,
    });
  });

  it('reads the camelCase spelling of every field', () => {
    // Both spellings ship in the wild across cursor-agent builds. Reading only
    // one would report a null context on whichever build uses the other, which
    // reads to the user as "the meter is broken", not "the CLI changed".
    expect(
      readCursorUsage({
        usage: { inputTokens: 120, outputTokens: 34 },
        cost_usd: 0.011,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      contextTokens: 120,
      contextWindowTokens: null,
      costUsd: 0.011,
    });
  });

  it('prefers the snake_case field when a line carries both', () => {
    expect(
      readCursorUsage({
        usage: {
          input_tokens: 7,
          inputTokens: 9,
          output_tokens: 1,
          outputTokens: 2,
        },
        total_cost_usd: 0.5,
        cost_usd: 0.9,
      }),
    ).toMatchObject({ inputTokens: 7, outputTokens: 1, costUsd: 0.5 });
  });

  it('reports the input count AS the context — cursor breaks out no cache tokens', () => {
    // Not a copy for symmetry's sake: this CLI has no cache-traffic breakdown,
    // so its plain input count is the best context figure that exists.
    const usage = readCursorUsage({ usage: { input_tokens: 4_096 } });
    expect(usage.contextTokens).toBe(4_096);
    expect(usage.inputTokens).toBe(4_096);
  });

  it('reports NO context window, so the consumer default is what scales the ring', () => {
    // Stated rather than assumed: a window invented here would silently
    // mis-scale the fill ring on every cursor turn.
    expect(
      readCursorUsage({ usage: { input_tokens: 1 } }).contextWindowTokens,
    ).toBeNull();
  });

  it('degrades a missing or wrong-typed usage block to nulls, never to zeros', () => {
    // A zero reads as "an empty context"; null reads as "not shown", which is
    // the honest answer when the CLI reported nothing.
    expect(readCursorUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      contextWindowTokens: null,
      costUsd: null,
    });
    expect(readCursorUsage({ usage: 'nope', total_cost_usd: 'free' })).toEqual({
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      contextWindowTokens: null,
      costUsd: null,
    });
  });
});
