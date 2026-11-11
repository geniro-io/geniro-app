import type { MemoryUsageCount, MemoryUsageField } from '../memory.types';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day a use is counted on. */
export function usageDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One use of each entry, on `at`'s day, in `field`. */
export function usesOf(
  memoryIds: Iterable<string>,
  field: MemoryUsageField,
  at: Date,
): MemoryUsageCount[] {
  const day = usageDay(at);
  return [...new Set(memoryIds)].map((memoryId) => ({
    memoryId,
    day,
    reads: 0,
    searchHits: 0,
    indexShows: 0,
    [field]: 1,
  }));
}
