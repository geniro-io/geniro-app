import { describe, expect, it } from 'vitest';

import {
  ClaudeSessionCostLedger,
  MAX_TRACKED_DELEGATE_MODELS,
  readClaudeAssistantContext,
  readClaudeUsage,
} from './claude-usage.utils';

/** Every real `result` line names its session; these fixtures are one turn each. */
const SESSION = 'sess-fixture';

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
  it('reports the cache split as the CUMULATIVE roll-up, beside the input count', () => {
    // The pair is what makes a turn's cost explicable: 14 fresh input tokens
    // beside 181,832 cache reads is not "almost nothing was sent". Deliberately
    // the roll-up and NOT the last request's 158/28,123 — that reading is
    // `contextTokens`, and conflating the two is what this file exists to stop.
    const usage = readClaudeUsage(
      { usage: SIX_TOOL_CALLS },
      new ClaudeSessionCostLedger(),
    );

    expect(usage.inputTokens).toBe(14);
    expect(usage.cacheCreationTokens).toBe(10_061);
    expect(usage.cacheReadTokens).toBe(181_832);
  });

  it('reads the thinking share of the output when the CLI breaks it down', () => {
    const usage = readClaudeUsage(
      {
        usage: {
          ...SIX_TOOL_CALLS,
          output_tokens_details: { thinking_tokens: 412 },
        },
      },
      new ClaudeSessionCostLedger(),
    );

    expect(usage.thinkingTokens).toBe(412);
  });

  it('reads a turn that reported a thinking share of ZERO as zero, not unknown', () => {
    // The distinction the null exists for, from the other side: a build that
    // breaks output down and says 0 is a turn that did not think, which is a
    // reading — while a build that says nothing has not been measured.
    const withZero = readClaudeUsage(
      {
        usage: {
          ...SIX_TOOL_CALLS,
          output_tokens_details: { thinking_tokens: 0 },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    const withNothing = readClaudeUsage(
      { usage: SIX_TOOL_CALLS },
      new ClaudeSessionCostLedger(),
    );

    expect(withZero.thinkingTokens).toBe(0);
    expect(withNothing.thinkingTokens).toBeNull();
  });

  it('reports the LAST request as context, not the turn-wide roll-up', () => {
    const usage = readClaudeUsage(
      {
        usage: SIX_TOOL_CALLS,
        session_id: SESSION,
        total_cost_usd: 0.213,
      },
      new ClaudeSessionCostLedger(),
    );

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
    const usage = readClaudeUsage(
      { usage: SIX_TOOL_CALLS },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.contextTokens).toBeGreaterThan(28_000);
  });

  it('takes the last iteration when a turn reports several', () => {
    const usage = readClaudeUsage(
      {
        usage: {
          iterations: [
            { input_tokens: 1, cache_read_input_tokens: 5_000 },
            { input_tokens: 1, cache_read_input_tokens: 9_000 },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.contextTokens).toBe(9_001);
  });

  it('answers null — never the roll-up — when a build reports no iterations', () => {
    const usage = readClaudeUsage(
      {
        usage: {
          input_tokens: 14,
          cache_creation_input_tokens: 10_061,
          cache_read_input_tokens: 181_832,
        },
      },
      new ClaudeSessionCostLedger(),
    );
    // Unknown reads as "no ctx shown"; the roll-up would read as a wrong one.
    expect(usage.contextTokens).toBeNull();
    expect(usage.inputTokens).toBe(14);
  });

  it('reads the window of the model that ran the turn', () => {
    const usage = readClaudeUsage(
      {
        usage: SIX_TOOL_CALLS,
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 14,
            cacheReadInputTokens: 181_832,
            cacheCreationInputTokens: 10_061,
            contextWindow: 1_000_000,
          },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.contextWindowTokens).toBe(1_000_000);
  });

  it('picks the model that did the work, not a side-errand model', () => {
    // A turn can bill a small model for background chores; measuring the main
    // model's context against THAT model's window is the mis-scaling this
    // whole field exists to stop.
    const usage = readClaudeUsage(
      {
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
      },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.contextWindowTokens).toBe(1_000_000);
  });

  it('answers null for a window nobody reported', () => {
    expect(
      readClaudeUsage({ usage: SIX_TOOL_CALLS }, new ClaudeSessionCostLedger())
        .contextWindowTokens,
    ).toBe(null);
    expect(
      readClaudeUsage(
        { usage: SIX_TOOL_CALLS, modelUsage: { m: { cost: 1 } } },
        new ClaudeSessionCostLedger(),
      ).contextWindowTokens,
    ).toBeNull();
  });

  it('survives a result line with no usage at all', () => {
    expect(readClaudeUsage({}, new ClaudeSessionCostLedger())).toEqual({
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
    });
  });

  it("reads the CLI's own turn timing off the result line", () => {
    // Verbatim from a live probe on 2.1.x (2026-08-14) — the fields alongside
    // `total_cost_usd` that were being dropped, which is why a finished turn
    // could report its cost and never how long it took.
    const usage = readClaudeUsage(
      {
        usage: SIX_TOOL_CALLS,
        duration_ms: 7618,
        duration_api_ms: 7176,
        session_id: SESSION,
        total_cost_usd: 0.211038,
      },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.durationMs).toBe(7618);
    // The split is the point: the remainder is the CLI's own work rather than
    // time the model spent thinking, which is what separates "the model was
    // slow" from "the agent did a lot".
    expect(usage.apiMs).toBe(7176);
  });

  it('reports no timing for a build that sends none, rather than a zero', () => {
    // A zero would render as `0s` — a turn that took no time at all — and the
    // consumer's wall-clock fallback would never be reached, since the field
    // would be present and numeric.
    const usage = readClaudeUsage(
      { usage: SIX_TOOL_CALLS },
      new ClaudeSessionCostLedger(),
    );
    expect(usage.durationMs).toBeNull();
    expect(usage.apiMs).toBeNull();
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

/**
 * The session roll-up, turned back into per-turn spend.
 *
 * The figures are the VERBATIM `result` fields of a two-turn probe against
 * claude 2.1.233 on one stdin session (`Reply with exactly: ONE`, then `TWO`),
 * which is what established that these two fields are session-scoped while the
 * token counts on the same line are not.
 */
describe('readClaudeUsage — cost is this turn, not the session so far', () => {
  const TURN_ONE = {
    session_id: 's-1',
    total_cost_usd: 0.1166802,
    duration_api_ms: 2219,
    duration_ms: 2395,
  };
  const TURN_TWO = {
    session_id: 's-1',
    total_cost_usd: 0.138462,
    duration_api_ms: 4159,
    duration_ms: 2093,
  };

  it('bills a turn for what it added, not for the running total', () => {
    const ledger = new ClaudeSessionCostLedger();
    expect(readClaudeUsage(TURN_ONE, ledger).costUsd).toBeCloseTo(0.1166802, 9);
    // The line SAYS 0.138462. Reading it as the turn's own is what billed a
    // $141 chat at $1,356 on the Stats page, because the ledger sums the rungs.
    expect(readClaudeUsage(TURN_TWO, ledger).costUsd).toBeCloseTo(0.0217818, 9);
  });

  it('bills API time the same way, and leaves the per-turn clock alone', () => {
    const ledger = new ClaudeSessionCostLedger();
    expect(readClaudeUsage(TURN_ONE, ledger).apiMs).toBe(2219);
    const second = readClaudeUsage(TURN_TWO, ledger);
    expect(second.apiMs).toBe(4159 - 2219);
    // `duration_ms` is already per-turn on the wire — subtracting it would turn
    // a correct figure into a negative one.
    expect(second.durationMs).toBe(2093);
  });

  it('keeps two concurrent sessions off each other s books', () => {
    const ledger = new ClaudeSessionCostLedger();
    readClaudeUsage(TURN_ONE, ledger);
    // A different process, mid-flight under graph fan-out. Its own first turn
    // must not be discounted by the other session's total.
    expect(
      readClaudeUsage(
        { session_id: 's-2', total_cost_usd: 0.5, duration_api_ms: 10 },
        ledger,
      ).costUsd,
    ).toBeCloseTo(0.5, 9);
  });

  it('takes the total whole when it DROPS — a reused id on a fresh ledger', () => {
    const ledger = new ClaudeSessionCostLedger();
    readClaudeUsage(TURN_TWO, ledger);
    // Clamping to zero here would silently drop a real turn's spend.
    expect(
      readClaudeUsage(
        { session_id: 's-1', total_cost_usd: 0.01, duration_api_ms: 5 },
        ledger,
      ).costUsd,
    ).toBeCloseTo(0.01, 9);
  });

  it('reports nothing rather than a running total when the line names no session', () => {
    expect(
      readClaudeUsage(
        { total_cost_usd: 12.34, duration_api_ms: 99 },
        new ClaudeSessionCostLedger(),
      ).costUsd,
    ).toBeNull();
  });

  it('forgets a session, so a later turn on that id is billed whole', () => {
    const ledger = new ClaudeSessionCostLedger();
    readClaudeUsage(TURN_ONE, ledger);
    ledger.forget('s-1');
    expect(readClaudeUsage(TURN_TWO, ledger).costUsd).toBeCloseTo(0.138462, 9);
  });
});

/**
 * `noteDelegateModel`'s own bookkeeping — which delegate models have already
 * been announced. `MAX_TRACKED_DELEGATE_MODELS` is not exported, so the cap
 * below is MEASURED off the ledger's own public behaviour rather than
 * hardcoded: a delegate still being tracked answers `false` to a repeat of
 * its own model (nothing changed), while one the eviction loop has dropped
 * has no memory of it at all and answers `true` again, exactly as if it were
 * new. That is the only signal available from outside the class, and it is
 * also the exact fact the eviction branch exists to produce — so deriving the
 * cap this way tracks the production constant automatically if it ever
 * changes, instead of silently going stale.
 */
describe('noteDelegateModel — per-process bookkeeping of announced models', () => {
  /** True once `extraDistinctIds` further delegates have pushed the FIRST one out. */
  it('is news again once the SAME delegate reports a CHANGED model', () => {
    const ledger = new ClaudeSessionCostLedger();
    expect(ledger.noteDelegateModel('call-1', 'model-a')).toBe(true); // first ever: news
    expect(ledger.noteDelegateModel('call-1', 'model-a')).toBe(false); // unchanged: not news
    // Nothing on this wire changes a model mid-delegate, but reporting a
    // change costs one row where suppressing it would leave the transcript
    // naming a model the delegate had stopped using.
    expect(ledger.noteDelegateModel('call-1', 'model-b')).toBe(true);
  });

  it('evicts the OLDEST delegate once the tracked cap is exceeded', () => {
    // Against the EXPORTED bound, not one measured off the implementation: a
    // cap derived by probing `noteDelegateModel` and then asserted back at the
    // same n passes for every value the constant could hold, so the one thing
    // this test names is the one thing it could not catch.
    const cap = MAX_TRACKED_DELEGATE_MODELS;

    const ledger = new ClaudeSessionCostLedger();
    ledger.noteDelegateModel('delegate-0', 'm');
    for (let i = 1; i <= cap; i++) {
      ledger.noteDelegateModel(`delegate-${i}`, 'm');
    }
    // `delegate-0` was the oldest entry; a process that has since tracked
    // (cap + 1) distinct delegates has forgotten it, so the identical note
    // reads as news rather than as the suppressed repeat it would be if the
    // entry were still held.
    expect(ledger.noteDelegateModel('delegate-0', 'm')).toBe(true);
  });
});
