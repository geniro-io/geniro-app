import { asArray, asNumber, asRecord } from '../../../utils/json-util';
import type { AgentUsage } from '../../adapter.types';

/**
 * Read one claude `result` line's token accounting.
 *
 * The subtlety this file exists for: `result.usage` is the turn's CUMULATIVE
 * total across every API request the turn made, NOT the conversation's size.
 * A turn that calls eight tools bills eight prompts, each one re-reading the
 * whole (cached) conversation — so summing that usage reports several times
 * the context that ever existed. Probed live on claude 2.1.220:
 *
 *   result.usage        input 12 · cache_creation 20_281 · cache_read 171_614  → 191_907
 *   last API request    input  2 · cache_creation    158 · cache_read  28_123  →  28_283
 *
 * The 191,907 figure is what put "ctx 2.8M / 200k" on a chat whose context had
 * never passed 30k. So context comes from `usage.iterations` — the per-request
 * breakdown, whose LAST entry is the final request's prompt — and never from
 * the roll-up. A CLI build that reports no iterations yields `null`: an unknown
 * context reads as "not shown", where the roll-up would read as a wrong number.
 *
 * `modelUsage` additionally names each model's real window
 * (`claude-opus-5[1m]` → 1_000_000), which is the only reason the ring can stop
 * measuring every model against an assumed 200k.
 */
export function readClaudeUsage(root: Record<string, unknown>): AgentUsage {
  const usage = asRecord(root.usage);
  const iterations = usage ? asArray(usage.iterations) : [];
  const lastRequest = asRecord(iterations[iterations.length - 1]);
  return {
    // Cumulative by nature and labelled as such — the turn's billed input.
    inputTokens: usage ? asNumber(usage.input_tokens) : null,
    outputTokens: usage ? asNumber(usage.output_tokens) : null,
    contextTokens: promptSideTokens(lastRequest),
    contextWindowTokens: readContextWindow(root),
    costUsd: asNumber(root.total_cost_usd),
  };
}

/**
 * How full the window is as of ONE `assistant` line — its `message.usage`.
 *
 * The live counterpart of {@link readClaudeUsage}'s `contextTokens`, and the
 * same arithmetic: an `assistant` line reports the usage of the single request
 * that produced it, which is exactly the per-request shape the roll-up must
 * never be confused with. PROBE-VERIFIED on claude 2.1.220 — every `assistant`
 * line carried `input_tokens` + `cache_creation_input_tokens` +
 * `cache_read_input_tokens`, while `contextWindow` appeared ONLY on `result`.
 *
 * Null when the line carries no usage, so a CLI build that omits it degrades
 * to "the meter waits for the turn to finish", never to a wrong number.
 */
export function readClaudeAssistantContext(
  message: Record<string, unknown>,
): number | null {
  return promptSideTokens(asRecord(message.usage));
}

/**
 * Everything one request put on the prompt side of the window: fresh input,
 * newly cached input, and cache reads. `input_tokens` alone excludes all cache
 * traffic, which on a resumed conversation is nearly the entire context.
 */
function promptSideTokens(
  request: Record<string, unknown> | null,
): number | null {
  if (!request) {
    return null;
  }
  const parts = [
    asNumber(request.input_tokens),
    asNumber(request.cache_creation_input_tokens),
    asNumber(request.cache_read_input_tokens),
  ].filter((part): part is number => part !== null);
  return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null;
}

/**
 * The window of the model that did the turn's work.
 *
 * `modelUsage` is keyed by model id and a turn can touch more than one (a small
 * model runs side errands), so the entry that spent the most prompt tokens is
 * the one the context figure above belongs to — matching by name would mean
 * this file knowing model ids, which is exactly what asking the CLI avoids.
 */
function readContextWindow(root: Record<string, unknown>): number | null {
  const modelUsage = asRecord(root.modelUsage);
  if (!modelUsage) {
    return null;
  }
  let window: number | null = null;
  let best = -1;
  for (const value of Object.values(modelUsage)) {
    const entry = asRecord(value);
    const contextWindow = entry ? asNumber(entry.contextWindow) : null;
    if (!entry || contextWindow === null) {
      continue;
    }
    const spent =
      (asNumber(entry.inputTokens) ?? 0) +
      (asNumber(entry.cacheCreationInputTokens) ?? 0) +
      (asNumber(entry.cacheReadInputTokens) ?? 0);
    if (spent > best) {
      best = spent;
      window = contextWindow;
    }
  }
  return window;
}
