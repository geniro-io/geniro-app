import { asNumber, asRecord } from '../../../utils/json-util';
import type { AgentUsage } from '../../adapter.types';

/**
 * Read one `cursor-agent` `result` line's token accounting.
 *
 * The peer of `claude/utils/claude-usage.utils.ts`, and deliberately NOT shared
 * with it: the two CLIs do not report the same thing. Claude breaks its usage
 * out per API request (`usage.iterations`) and names each model's window
 * (`modelUsage[*].contextWindow`); cursor-agent reports neither. A single
 * base-class reader would therefore have to know both CLIs' field names — the
 * one thing the adapter layer exists to prevent — so each CLI reads its own.
 *
 * Every field is read under BOTH the snake_case and camelCase spelling. Cursor's
 * stream-json is version-volatile (the spec flags its schema drift as HIGH) and
 * both spellings have been seen in the wild, so reading one alone would report
 * a null context on whichever build uses the other.
 */
export function readCursorUsage(root: Record<string, unknown>): AgentUsage {
  const usage = asRecord(root.usage);
  const inputTokens = usage
    ? (asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens))
    : null;
  return {
    inputTokens,
    outputTokens: usage
      ? (asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens))
      : null,
    // Cursor doesn't break out cache tokens — its input count IS the best
    // available context figure.
    contextTokens: inputTokens,
    // cursor-agent reports no window for the model it ran, so the consumer's
    // default stands. Stated here rather than assumed: a wrong window silently
    // mis-scales the fill ring, which is the whole reason claude reports one.
    contextWindowTokens: null,
    costUsd: asNumber(root.total_cost_usd) ?? asNumber(root.cost_usd),
  };
}
