/** Ids per `IN (…)` query — far inside SQLite's bound-variable cap. */
export const ID_BATCH = 500;

/** `ids` cut into windows of {@link ID_BATCH}, one `IN` query each. */
export function idBatches<T>(ids: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < ids.length; at += ID_BATCH) {
    batches.push(ids.slice(at, at + ID_BATCH));
  }
  return batches;
}
