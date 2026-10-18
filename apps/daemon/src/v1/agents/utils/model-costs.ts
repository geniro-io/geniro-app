import type { AgentModelCost } from '../adapters/adapter.types';

/**
 * How far a split's parts may sum from the cost they split: rounding in the
 * CLI's own figures (it states each model to ~15 digits and the total
 * separately), never a gap a missing model would leave.
 */
const SPLIT_TOLERANCE_USD = 0.005;

/** Below this a model's share is rounding, not spend, and is not listed. */
const MIN_SHARE_USD = 0.000_001;

/**
 * Several per-model lists as one — summed per model, costliest first, models
 * that spent nothing dropped.
 */
export function mergeModelCosts(
  parts: readonly (readonly AgentModelCost[])[],
): AgentModelCost[] {
  const byModel = new Map<string, number>();
  for (const part of parts) {
    for (const entry of part) {
      byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + entry.costUsd);
    }
  }
  return [...byModel.entries()]
    .filter(([, costUsd]) => costUsd > MIN_SHARE_USD)
    .map(([model, costUsd]) => ({ model, costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
}

/**
 * The split when it accounts for exactly `costUsd`, else null — a split that
 * does not add up is a claim about where money went that the total refutes.
 */
export function splitOf(
  costs: readonly AgentModelCost[] | null | undefined,
  costUsd: number | null,
): AgentModelCost[] | null {
  if (costs === null || costs === undefined || costUsd === null) {
    return null;
  }
  const merged = mergeModelCosts([costs]);
  if (merged.length === 0) {
    return null;
  }
  const sum = merged.reduce((total, entry) => total + entry.costUsd, 0);
  return Math.abs(sum - costUsd) <= SPLIT_TOLERANCE_USD ? merged : null;
}
