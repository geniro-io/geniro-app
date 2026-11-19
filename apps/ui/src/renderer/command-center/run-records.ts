/** What this device remembers about each thread under one localStorage key, by run id. */
export type RunRecords<T> = Readonly<Record<string, T>>;

/** The records under `key` that pass `isRecord`; empty when none or unreadable. */
export function readRunRecords<T>(
  key: string,
  isRecord: (value: unknown) => value is T,
): RunRecords<T> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (typeof stored !== 'object' || stored === null) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(stored).filter(([, value]) => isRecord(value)),
    ) as RunRecords<T>;
  } catch {
    return {};
  }
}

export function writeRunRecords<T>(key: string, records: RunRecords<T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(records));
  } catch {
    return;
  }
}

/** `records` with `runId` set last, the oldest dropped past `cap`. */
export function withRunRecord<T>(
  records: RunRecords<T>,
  runId: string,
  value: T,
  cap: number,
): RunRecords<T> {
  const entries = Object.entries(records).filter(([id]) => id !== runId);
  entries.push([runId, value]);
  return Object.fromEntries(entries.slice(-cap));
}

/** `records` without the threads outside `runIds` — the same object when none left. */
export function keptRunRecords<T>(
  records: RunRecords<T>,
  runIds: ReadonlySet<string>,
): RunRecords<T> {
  const kept = Object.entries(records).filter(([id]) => runIds.has(id));
  return kept.length === Object.keys(records).length
    ? records
    : Object.fromEntries(kept);
}

/** Whether `value` is an object whose `keys` are all finite numbers. */
export function hasFiniteNumbers<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, number> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return keys.every((key) => {
    const field = fields[key];
    return typeof field === 'number' && Number.isFinite(field);
  });
}
