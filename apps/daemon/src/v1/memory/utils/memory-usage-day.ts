import type { MemoryUsageCount, MemoryUsageField } from '../memory.types';

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
