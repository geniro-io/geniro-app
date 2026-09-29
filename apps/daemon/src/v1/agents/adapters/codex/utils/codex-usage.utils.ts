import { asNumber, asRecord } from '../../../utils/json-util';
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
 * counts cached tokens inside its input figure (OpenAI's convention), while
 * every consumer here reads input and cache reads as separate, additive
 * quantities. codex prices nothing on its wire, so the cost is null rather
 * than a zero nobody measured.
 */
export function turnUsageOf(options: {
  latest: CodexTokenUsage | null;
  baseline: CodexTokenBreakdown | null;
  model: string | null;
  durationMs: number | null;
}): AgentUsage {
  const { latest, baseline } = options;
  const delta = (pick: (b: CodexTokenBreakdown) => number): number | null =>
    latest === null || baseline === null
      ? null
      : Math.max(0, pick(latest.total) - pick(baseline));
  const input = delta((b) => b.inputTokens);
  const cached = delta((b) => b.cachedInputTokens);
  const context = latest?.last.totalTokens ?? null;
  const window = latest?.modelContextWindow ?? null;
  return {
    inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: delta((b) => b.outputTokens),
    cacheReadTokens: cached,
    cacheCreationTokens: delta((b) => b.cacheWriteInputTokens),
    thinkingTokens: delta((b) => b.reasoningOutputTokens),
    contextTokens: context !== null && context > 0 ? context : null,
    contextWindowTokens: window,
    contextModel: window !== null ? options.model : null,
    costUsd: null,
    durationMs: options.durationMs,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
  };
}
