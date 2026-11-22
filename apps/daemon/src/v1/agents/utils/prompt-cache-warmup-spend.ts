export interface PromptCacheWarmupSpent {
  promptCacheWarmupCostUsd: number;
}

export function addPromptCacheWarmupSpend<
  T extends { costUsd: number | null; estimatedCostUsd: number | null },
>(totals: T, members: readonly PromptCacheWarmupSpent[]): T {
  const spent = members.reduce(
    (sum, member) => sum + member.promptCacheWarmupCostUsd,
    0,
  );
  if (spent <= 0) {
    return totals;
  }
  return {
    ...totals,
    costUsd: (totals.costUsd ?? 0) + spent,
    estimatedCostUsd: (totals.estimatedCostUsd ?? 0) + spent,
  };
}
