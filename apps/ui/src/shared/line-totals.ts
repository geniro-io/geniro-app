/** The lines one change added and removed. A null count is a change whose lines were not counted. */
export interface LineCounts {
  added: number | null;
  removed: number | null;
}

/**
 * The lines a list of changes added and removed, summed per count. A count is null when no
 * change in the list measured it: the sum of nothing is not a zero, and a reader must not
 * take it for one.
 */
export function sumLineTotals(changes: readonly LineCounts[]): LineCounts {
  let added: number | null = null;
  let removed: number | null = null;
  for (const change of changes) {
    if (change.added !== null) {
      added = (added ?? 0) + change.added;
    }
    if (change.removed !== null) {
      removed = (removed ?? 0) + change.removed;
    }
  }
  return { added, removed };
}
