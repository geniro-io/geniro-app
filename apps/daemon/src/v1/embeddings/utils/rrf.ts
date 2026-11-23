/** One ranked list a search fuses, best first, with how much a place in it counts. */
export interface RankedList {
  ids: readonly string[];
  weight: number;
}

/** The constant of reciprocal rank fusion: it flattens the gap between the first places. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion of several ranked lists: each id scores the sum of
 * `weight / (RRF_K + rank)` over the lists it appears in (rank counted from 1),
 * scaled so the best id is 1 and every other lies in (0, 1].
 */
export function fuseRanks(lists: readonly RankedList[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ids, weight } of lists) {
    ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1));
    });
  }
  const best = Math.max(0, ...scores.values());
  const relevance = new Map<string, number>();
  for (const [id, score] of scores) {
    relevance.set(id, best > 0 ? Math.max(Number.MIN_VALUE, score / best) : 1);
  }
  return relevance;
}
