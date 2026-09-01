/**
 * Anthropic's LIST prices, in dollars per million tokens, for the models this
 * CLI runs.
 *
 * This table exists to price ONE thing the CLI refuses to price itself: a
 * single delegate. Probed on 2.1.251 across every channel that says anything
 * about one — `task_started`, `task_updated`, `task_notification`, the
 * launching call's `tool_use_result`, and the delegate's own sidechain JSONL —
 * not one carries money. The turn's `result` line carries all of it, and
 * `modelUsage[model].costUSD` covers the main thread and every delegate
 * together with no split. So a delegate's dollars are either derived here or
 * not shown at all.
 *
 * **It is never trusted on its own.** Every figure this table produces is
 * multiplied by a calibration factor solved from the SAME turn's `result` line
 * — see {@link ClaudeDelegateCostLedger}. That is what keeps a hardcoded price
 * list from going quietly wrong: the CLI states what the turn really cost, so
 * this table's error against reality is measured on every single turn rather
 * than assumed away, and a table that has drifted is corrected by exactly the
 * factor it drifted by.
 *
 * The calibration is also why the table can be INCOMPLETE without lying. A
 * model absent here prices to null, the delegate shows tokens and no dollars,
 * and nothing on screen is wrong — which is the failure mode a price table
 * must have when a model ships that this build has never heard of.
 *
 * Keys are CANONICAL model ids. The CLI reports variants (`claude-opus-5[1m]`),
 * and the bracket suffix is deliberately NOT a row of its own: it selects a
 * context tier whose premium is exactly what the calibration measures. Pricing
 * the variant at its own rate here and calibrating on top would count the same
 * premium twice.
 */
export interface ClaudeModelPrice {
  /** Dollars per million fresh input tokens. */
  input: number;
  /** Dollars per million output tokens. */
  output: number;
}

export const CLAUDE_LIST_PRICES: ReadonlyMap<string, ClaudeModelPrice> =
  new Map([
    ['claude-fable-5', { input: 10, output: 50 }],
    ['claude-mythos-5', { input: 10, output: 50 }],
    ['claude-opus-5', { input: 5, output: 25 }],
    ['claude-opus-4-8', { input: 5, output: 25 }],
    ['claude-opus-4-7', { input: 5, output: 25 }],
    ['claude-opus-4-6', { input: 5, output: 25 }],
    ['claude-sonnet-5', { input: 2, output: 10 }],
    ['claude-sonnet-4-6', { input: 3, output: 15 }],
    ['claude-haiku-4-5', { input: 1, output: 5 }],
  ]);

/**
 * Cache traffic, as multiples of a model's INPUT price.
 *
 * Ratios rather than per-model rows because they are properties of the API
 * rather than of a model: a 5-minute cache write bills 1.25x input and a cache
 * read 0.1x on every model in the table above. Writing them per model would be
 * nine chances to mistype one number that never varies.
 *
 * The 1-hour cache write (2x) is deliberately absent. The delegate breakdown
 * this prices reports `cache_creation_input_tokens` as ONE figure with no TTL
 * split, so a second rate would have nothing to apply itself to — and the
 * calibration below absorbs the difference for a turn that used both.
 */
export const CLAUDE_CACHE_WRITE_MULTIPLIER = 1.25;
/** @see CLAUDE_CACHE_WRITE_MULTIPLIER */
export const CLAUDE_CACHE_READ_MULTIPLIER = 0.1;

/**
 * The canonical id behind a reported one — `claude-opus-5[1m]` →
 * `claude-opus-5`.
 *
 * The CLI's `modelUsage` keys and a delegate's `resolvedModel` both carry the
 * variant suffix, and both are matched against {@link CLAUDE_LIST_PRICES}
 * through here so the two can never disagree about what a model is called.
 */
export function canonicalClaudeModel(model: string): string {
  const bracket = model.indexOf('[');
  return bracket === -1 ? model : model.slice(0, bracket);
}
