import { asNumber, asRecord } from './json-util';

/**
 * The run row's outstanding spend (`Run.unrecordedSpend`): live-plane owner
 * key → dollars that owner's process has spent and no durable row records yet,
 * or `{costUsd, estimatedCostUsd}` when part of them was priced by geniro — a
 * bare number has no estimated part.
 *
 * Read back DEFENSIVELY — the column is TEXT this daemon wrote, but a row from
 * an older build or a hand edit must cost the entries it cannot read, never
 * the run. Only a positive, finite figure is an entry: zero is "nothing
 * outstanding", which is the ABSENCE of an entry, so the two cannot disagree.
 */
export function readUnrecordedSpend(json: string | null): Map<string, number> {
  return readEntries(json, (value) =>
    asNumber(asRecord(value)?.costUsd ?? value),
  );
}

/**
 * Of each owner's figure in {@link readUnrecordedSpend}, the part geniro priced
 * itself — stored beside the dollars as `{costUsd, estimatedCostUsd}`, where a
 * bare number is an entry with none.
 */
export function readUnrecordedEstimates(
  json: string | null,
): Map<string, number> {
  return readEntries(json, (value) =>
    asNumber(asRecord(value)?.estimatedCostUsd),
  );
}

function readEntries(
  json: string | null,
  figureOf: (value: unknown) => number | null,
): Map<string, number> {
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
    const costUsd = figureOf(value);
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
  estimates: ReadonlyMap<string, number> = new Map(),
): string | null {
  const entries = [...spend]
    .filter(([, costUsd]) => isOutstanding(costUsd))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ownerKey, costUsd]) => {
      const estimatedCostUsd = estimates.get(ownerKey) ?? null;
      return [
        ownerKey,
        isOutstanding(estimatedCostUsd)
          ? { costUsd, estimatedCostUsd }
          : costUsd,
      ] as const;
    });
  return entries.length === 0
    ? null
    : JSON.stringify(Object.fromEntries(entries));
}

/** Whether a reading is money still owed a row: positive and finite. */
export function isOutstanding(costUsd: number | null): costUsd is number {
  return costUsd !== null && Number.isFinite(costUsd) && costUsd > 0;
}
