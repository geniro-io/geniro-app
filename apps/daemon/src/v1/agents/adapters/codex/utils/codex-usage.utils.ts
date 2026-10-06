import { asNumber, asRecord } from '../../../utils/json-util';
import {
  type ModelPrice,
  ratesForPrompt,
  tokenCostUsd,
} from '../../../utils/model-prices';
import type { AgentUsage } from '../../adapter.types';
import type { CodexTokenBreakdown, CodexTokenUsage } from '../codex.types';

/** One breakdown, or null when a figure is missing — a partial one is unusable. */
function readBreakdown(value: unknown): CodexTokenBreakdown | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const fields = {
    totalTokens: asNumber(record.totalTokens),
    inputTokens: asNumber(record.inputTokens),
    cachedInputTokens: asNumber(record.cachedInputTokens) ?? 0,
    cacheWriteInputTokens: asNumber(record.cacheWriteInputTokens) ?? 0,
    outputTokens: asNumber(record.outputTokens),
    reasoningOutputTokens: asNumber(record.reasoningOutputTokens) ?? 0,
  };
  if (
    fields.totalTokens === null ||
    fields.inputTokens === null ||
    fields.outputTokens === null
  ) {
    return null;
  }
  return {
    totalTokens: fields.totalTokens,
    inputTokens: fields.inputTokens,
    cachedInputTokens: fields.cachedInputTokens,
    cacheWriteInputTokens: fields.cacheWriteInputTokens,
    outputTokens: fields.outputTokens,
    reasoningOutputTokens: fields.reasoningOutputTokens,
  };
}

/** A `thread/tokenUsage/updated` params object's `tokenUsage`, or null. */
export function readTokenUsage(params: unknown): CodexTokenUsage | null {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const total = readBreakdown(usage?.total);
  const last = readBreakdown(usage?.last);
  if (total === null || last === null) {
    return null;
  }
  const window = asNumber(usage?.modelContextWindow);
  return {
    total,
    last,
    modelContextWindow: window !== null && window > 0 ? window : null,
  };
}

/**
 * The thread's running total as it stood BEFORE a turn, derived from that
 * turn's first reading: the first request's own figures (`last`) subtracted
 * from the total they were added to. Exact where "the total we saw last turn"
 * is not — a resumed thread's first turn on a fresh process has no earlier
 * reading at all, and its total starts at every token the thread ever used.
 */
export function baselineOf(first: CodexTokenUsage): CodexTokenBreakdown {
  const minus = (a: number, b: number): number => Math.max(0, a - b);
  return {
    totalTokens: minus(first.total.totalTokens, first.last.totalTokens),
    inputTokens: minus(first.total.inputTokens, first.last.inputTokens),
    cachedInputTokens: minus(
      first.total.cachedInputTokens,
      first.last.cachedInputTokens,
    ),
    cacheWriteInputTokens: minus(
      first.total.cacheWriteInputTokens,
      first.last.cacheWriteInputTokens,
    ),
    outputTokens: minus(first.total.outputTokens, first.last.outputTokens),
    reasoningOutputTokens: minus(
      first.total.reasoningOutputTokens,
      first.last.reasoningOutputTokens,
    ),
  };
}

/**
 * What one turn used, as the `AgentUsage` a `turn_complete` carries.
 *
 * `inputTokens` is the UNCACHED input, so it means what claude's does: codex
 * counts cached AND cache-written tokens inside its input figure (OpenAI's
 * convention — codex 0.157.1's own binary reads them from the Responses API's
 * `input_tokens_details.{cached_tokens, cache_write_tokens}`, i.e. as DETAILS
 * of `input_tokens`), while every consumer here reads fresh input, cache reads
 * and cache writes as separate, additive quantities.
 *
 * Output, by contrast, already INCLUDES reasoning: measured on 0.157.1, a
 * reading of `input 35167 · output 250 · reasoning 167 · total 35417` has
 * `total = input + output`, so reasoning is a share of output and is never
 * added to it again — `thinkingTokens` reports the share, the price bills the
 * output once.
 *
 * codex prices nothing on its wire (only an Enterprise workspace sees a dollar
 * estimate), so the cost is the turn's tokens at the model's LIST price, when
 * the caller has one ({@link ModelPrice} from the public catalog):
 *
 *   uncached input × input + cached × cache_read
 *     + cache-write × cache_write + output × output
 *
 * at the rates of the context tier the turn's LAST request fell in (its
 * prompt, `last.inputTokens`, past a tier's size bills the whole turn at that
 * tier). That is an approximation in one direction only: a turn whose early
 * requests were under the threshold and whose last one was over it is billed
 * at the higher rate throughout. A turn's requests are not reported one by one
 * reliably enough to price them separately, and the last request is the
 * largest in all but a turn that compacted.
 *
 * No price — an unknown model, or no catalog — is a null cost, never $0.
 */
export function turnUsageOf(options: {
  latest: CodexTokenUsage | null;
  baseline: CodexTokenBreakdown | null;
  model: string | null;
  durationMs: number | null;
  /** The model's list price, or null when nobody can price it. */
  price: ModelPrice | null;
}): AgentUsage {
  const { latest, baseline, price } = options;
  const delta = (pick: (b: CodexTokenBreakdown) => number): number | null =>
    latest === null || baseline === null
      ? null
      : Math.max(0, pick(latest.total) - pick(baseline));
  const input = delta((b) => b.inputTokens);
  const cached = delta((b) => b.cachedInputTokens);
  const cacheWrite = delta((b) => b.cacheWriteInputTokens);
  const output = delta((b) => b.outputTokens);
  const uncached =
    input === null
      ? null
      : Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0));
  const context = latest?.last.totalTokens ?? null;
  const window = latest?.modelContextWindow ?? null;
  const costUsd =
    price === null || latest === null || uncached === null || output === null
      ? null
      : tokenCostUsd(ratesForPrompt(price, latest.last.inputTokens), {
          inputTokens: uncached,
          outputTokens: output,
          cacheReadTokens: cached,
          cacheWriteTokens: cacheWrite,
        });
  return {
    inputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheCreationTokens: cacheWrite,
    thinkingTokens: delta((b) => b.reasoningOutputTokens),
    contextTokens: context !== null && context > 0 ? context : null,
    contextWindowTokens: window,
    contextModel: window !== null ? options.model : null,
    costUsd,
    durationMs: options.durationMs,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
  };
}
