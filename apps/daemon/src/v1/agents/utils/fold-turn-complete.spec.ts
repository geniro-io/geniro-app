import { describe, expect, it } from 'vitest';

import type { AgentEvent, AgentUsage } from '../adapters/adapter.types';
import { foldTurnComplete } from './fold-turn-complete';

type TurnComplete = Extract<AgentEvent, { type: 'turn_complete' }>;

const NOTHING_MEASURED: AgentUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  thinkingTokens: null,
  contextTokens: null,
  contextWindowTokens: null,
  contextModel: null,
  costUsd: null,
  durationMs: null,
  apiMs: null,
};

function complete(
  usage: Partial<AgentUsage> | null,
  finalText: string | null = null,
): TurnComplete {
  return {
    type: 'turn_complete',
    usage: usage === null ? null : { ...NOTHING_MEASURED, ...usage },
    stopReason: 'end_turn',
    finalText,
  };
}

describe('foldTurnComplete', () => {
  it('sums what each segment did', () => {
    const folded = foldTurnComplete(
      complete({ outputTokens: 100, costUsd: 1.1, durationMs: 600 }),
      complete({ outputTokens: 40, costUsd: 0.6, durationMs: 100 }),
    );

    expect(folded.usage).toMatchObject({
      outputTokens: 140,
      costUsd: 1.7000000000000002,
      durationMs: 700,
    });
  });

  it('keeps a figure neither segment measured as not measured, never zero', () => {
    const folded = foldTurnComplete(
      complete({ costUsd: 1 }),
      complete({ costUsd: 2 }),
    );

    expect(folded.usage?.thinkingTokens).toBeNull();
  });

  it('takes the window from the LATER reading, with the model it describes', () => {
    const folded = foldTurnComplete(
      complete({
        contextTokens: 200,
        contextWindowTokens: 1_000_000,
        contextModel: 'opus[1m]',
      }),
      complete({
        contextTokens: 300,
        contextWindowTokens: 200_000,
        contextModel: 'sonnet',
      }),
    );

    expect(folded.usage).toMatchObject({
      contextTokens: 300,
      contextWindowTokens: 200_000,
      contextModel: 'sonnet',
    });
  });

  it('keeps the earlier window and ITS model when the later names none', () => {
    const folded = foldTurnComplete(
      complete({ contextWindowTokens: 1_000_000, contextModel: 'opus[1m]' }),
      complete({ contextModel: 'sonnet' }),
    );

    expect(folded.usage).toMatchObject({
      contextWindowTokens: 1_000_000,
      contextModel: 'opus[1m]',
    });
  });

  it('ends on the later answer, and falls back to the earlier one', () => {
    expect(
      foldTurnComplete(complete(null, 'first'), complete(null, 'second'))
        .finalText,
    ).toBe('second');
    expect(
      foldTurnComplete(complete(null, 'first'), complete(null, null)).finalText,
    ).toBe('first');
  });

  it('keeps the one bill there is when a segment reported none', () => {
    expect(
      foldTurnComplete(complete({ costUsd: 1 }), complete(null)).usage?.costUsd,
    ).toBe(1);
  });
});
