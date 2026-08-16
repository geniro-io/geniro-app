import { describe, expect, it } from 'vitest';

import {
  addUsage,
  emptyTotals,
  sumUsagePayloads,
  type UsageFigures,
  usageFiguresFrom,
  usageFiguresFromRaw,
} from './usage-figures';

/**
 * This module is the single point where "the CLI did not report it" becomes
 * null, for both the per-chat metrics panel and the Stats page's ledger. The
 * cases below are the ones that were missing: a PARTIAL payload — the actual
 * cursor-agent shape, where tokens are present and cost, cache and timings are
 * not — and non-numeric values. Without them, defaulting any field to 0 here
 * left every other spec in both features green while writing a fabricated
 * figure into an append-only ledger no backfill would go back and correct.
 */
describe('usageFiguresFrom', () => {
  it('reads every field a turn reported', () => {
    expect(
      usageFiguresFrom({
        usage: {
          costUsd: 0.4,
          inputTokens: 800,
          outputTokens: 150,
          cacheReadTokens: 40,
          cacheCreationTokens: 5,
          thinkingTokens: 3,
          durationMs: 2_000,
          apiMs: 1_500,
        },
      }),
    ).toEqual({
      costUsd: 0.4,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      thinkingTokens: 3,
      durationMs: 2_000,
      apiMs: 1_500,
    });
  });

  it('leaves every UNREPORTED field null while keeping the reported ones', () => {
    // The cursor-agent shape: input/output tokens only. Defaulting any of the
    // absent fields to 0 would claim this turn was free and instantaneous.
    expect(
      usageFiguresFrom({ usage: { inputTokens: 800, outputTokens: 150 } }),
    ).toEqual({
      costUsd: null,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
    });
  });

  it('keeps a genuinely reported zero, which is not the same as silence', () => {
    const figures = usageFiguresFrom({
      usage: { costUsd: 0, cacheReadTokens: 0 },
    });

    expect(figures?.costUsd).toBe(0);
    expect(figures?.cacheReadTokens).toBe(0);
    // …and the fields alongside them stay null, so one turn carries both
    // meanings at once without either collapsing into the other.
    expect(figures?.inputTokens).toBeNull();
  });

  it('refuses a value that is not a finite number rather than fabricating one', () => {
    const figures = usageFiguresFrom({
      usage: {
        costUsd: '0.4',
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        thinkingTokens: null,
        apiMs: { nested: 1 },
      },
    });

    // A version-volatile CLI payload degrades to "not measured" — never to a
    // coerced number, and never to a NaN that would poison every total it is
    // added into.
    expect(figures).toEqual({
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
    });
  });

  it('answers null for a payload carrying no usage at all', () => {
    // Distinct from a payload whose usage is present but empty: this turn is
    // not counted at all, rather than counted with nothing measured.
    expect(usageFiguresFrom({ stopReason: 'end_turn' })).toBeNull();
    expect(usageFiguresFrom({ usage: null })).toBeNull();
    expect(usageFiguresFrom({ usage: 'nope' })).toBeNull();
    expect(usageFiguresFrom(null)).toBeNull();
  });

  it('counts a turn whose usage object is present but empty', () => {
    // The turn happened and reported an (empty) accounting, so it IS a turn —
    // with every figure unmeasured.
    expect(usageFiguresFrom({ usage: {} })).toEqual({
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
    });
  });
});

describe('usageFiguresFromRaw', () => {
  it('reads a stored payload', () => {
    expect(
      usageFiguresFromRaw(JSON.stringify({ usage: { costUsd: 1.25 } }))
        ?.costUsd,
    ).toBe(1.25);
  });

  it('answers null for a payload that will not parse', () => {
    // One unreadable row costs its own turn's accounting, never the caller's
    // whole sweep.
    expect(usageFiguresFromRaw('not json {')).toBeNull();
    expect(usageFiguresFromRaw('')).toBeNull();
  });
});

function figures(overrides: Partial<UsageFigures> = {}): UsageFigures {
  return {
    costUsd: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 2,
    thinkingTokens: 1,
    durationMs: 1_000,
    apiMs: 800,
    ...overrides,
  };
}

describe('emptyTotals', () => {
  it('starts every figure at null, and only the turn count at zero', () => {
    expect(emptyTotals()).toEqual({
      turns: 0,
      costedTurns: 0,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      workedMs: null,
    });
  });
});

describe('addUsage', () => {
  it('accumulates every reported figure and counts the turn', () => {
    const totals = emptyTotals();

    addUsage(totals, figures());
    addUsage(totals, figures());

    expect(totals).toEqual({
      turns: 2,
      costedTurns: 2,
      costUsd: 0.2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheCreationTokens: 4,
      thinkingTokens: 2,
      workedMs: 2_000,
    });
  });

  it('leaves a figure null when no turn reported it', () => {
    const totals = emptyTotals();

    addUsage(totals, figures({ costUsd: null, thinkingTokens: null }));
    addUsage(totals, figures({ costUsd: null, thinkingTokens: null }));

    expect(totals.costUsd).toBeNull();
    expect(totals.thinkingTokens).toBeNull();
    expect(totals.inputTokens).toBe(200);
    expect(totals.turns).toBe(2);
  });

  it('does not let one CLI’s silence dilute another’s measurement', () => {
    const totals = emptyTotals();

    addUsage(totals, figures({ costUsd: 0.75 }));
    addUsage(totals, figures({ costUsd: null }));

    // 0.75, not 0.375 — the unreported turn contributes nothing rather than a
    // zero, so the sum is what was actually spent.
    expect(totals.costUsd).toBe(0.75);
    expect(totals.turns).toBe(2);
  });

  it('counts only the turns that reported a cost as costed', () => {
    const totals = emptyTotals();

    addUsage(totals, figures({ costUsd: 1 }));
    addUsage(totals, figures({ costUsd: null }));
    addUsage(totals, figures({ costUsd: 0 }));

    // Three turns happened; two priced them. An average spend divided by
    // `turns` would report 0.33 for work that actually cost 0.50 per priced
    // turn — the dilution this field exists to remove. A measured 0 IS a
    // price, so it counts.
    expect(totals.turns).toBe(3);
    expect(totals.costedTurns).toBe(2);
    expect(totals.costUsd).toBe(1);
  });

  it('leaves worked time unmeasured when the CLI reported no duration', () => {
    const totals = emptyTotals();

    addUsage(totals, figures({ durationMs: null }));

    expect(totals.workedMs).toBeNull();
  });
});

describe('sumUsagePayloads', () => {
  it('totals the turns that reported usage and skips the rest', () => {
    const totals = sumUsagePayloads([
      JSON.stringify({ usage: { costUsd: 1, inputTokens: 100 } }),
      JSON.stringify({ stopReason: 'end_turn' }),
      'not json {',
      JSON.stringify({ usage: { costUsd: 2, inputTokens: 50 } }),
    ]);

    // Two of the four payloads carry usage; the turn count must reflect that
    // rather than the number of rows read.
    expect(totals).toMatchObject({ turns: 2, costUsd: 3, inputTokens: 150 });
  });

  it('answers an all-null total for a thread whose CLI reports nothing', () => {
    const totals = sumUsagePayloads([
      JSON.stringify({ usage: { inputTokens: 10 } }),
      JSON.stringify({ usage: { inputTokens: 20 } }),
    ]);

    expect(totals.turns).toBe(2);
    expect(totals.inputTokens).toBe(30);
    // "not measured", not "cost nothing" — the whole point of the fold.
    expect(totals.costUsd).toBeNull();
    expect(totals.workedMs).toBeNull();
  });
});
