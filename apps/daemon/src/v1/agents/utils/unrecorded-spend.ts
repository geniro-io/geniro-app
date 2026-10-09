import { asNumber, asRecord } from './json-util';

/**
 * The run row's outstanding spend (`Run.unrecordedSpend`): live-plane owner
 * key → dollars that owner's process has spent and no durable row records yet.
 *
 * Read back DEFENSIVELY — the column is TEXT this daemon wrote, but a row from
 * an older build or a hand edit must cost the entries it cannot read, never
 * the run. Only a positive, finite figure is an entry: zero is "nothing
 * outstanding", which is the ABSENCE of an entry, so the two cannot disagree.
 */
export function readUnrecordedSpend(json: string | null): Map<string, number> {
  const spend = new Map<string, number>();
  if (json === null || json === '') {
    return spend;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return spend;
  }
  for (const [ownerKey, value] of Object.entries(asRecord(parsed) ?? {})) {
    const costUsd = asNumber(value);
    if (ownerKey !== '' && isOutstanding(costUsd)) {
      spend.set(ownerKey, costUsd);
    }
  }
  return spend;
}

/**
 * The column's value for a set of entries — null when none is outstanding, so
 * a run with nothing owed carries no JSON at all and the boot rehydration's
 * `IS NOT NULL` scan finds exactly the runs it has work for. Keys are sorted
 * so an unchanged set always serializes to the same text, which is what lets a
 * writer skip a write that would change nothing.
 */
export function writeUnrecordedSpend(
  spend: ReadonlyMap<string, number>,
): string | null {
  const entries = [...spend]
    .filter(([, costUsd]) => isOutstanding(costUsd))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0
    ? null
    : JSON.stringify(Object.fromEntries(entries));
}

/** Whether a reading is money still owed a row: positive and finite. */
export function isOutstanding(costUsd: number | null): costUsd is number {
  return costUsd !== null && Number.isFinite(costUsd) && costUsd > 0;
}
