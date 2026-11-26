import { useState } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';
import {
  keptRunRecords,
  readRunRecords,
  type RunRecords,
  withRunRecord,
  writeRunRecords,
} from './run-records';

export interface StoredRecords<T> {
  records: RunRecords<T>;
  set: (id: string, value: T) => void;
  forget: (id: string) => void;
  /** Forget every record whose id is not in `ids`. */
  keepOnly: (ids: ReadonlySet<string>) => void;
  /** Replace the records with what `next` makes of them; the same object writes nothing. */
  update: (next: (current: RunRecords<T>) => RunRecords<T>) => void;
  reset: () => void;
}

/** Records this device keeps under one localStorage key, by id, at most `cap` of them. */
export function useStoredRecords<T>(
  key: string,
  isRecord: (value: unknown) => value is T,
  cap: number,
): StoredRecords<T> {
  const [records, setRecords] = useState<RunRecords<T>>(() =>
    readRunRecords(key, isRecord),
  );
  const update = useLatestCallback(
    (next: (current: RunRecords<T>) => RunRecords<T>): void =>
      setRecords((current) => {
        const changed = next(current);
        if (changed !== current) {
          writeRunRecords(key, changed);
        }
        return changed;
      }),
    [],
  );
  const set = useLatestCallback(
    (id: string, value: T): void =>
      update((current) => withRunRecord(current, id, value, cap)),
    [],
  );
  const forget = useLatestCallback(
    (id: string): void =>
      update((current) => {
        if (current[id] === undefined) {
          return current;
        }
        const next = { ...current };
        delete next[id];
        return next;
      }),
    [],
  );
  const keepOnly = useLatestCallback(
    (ids: ReadonlySet<string>): void =>
      update((current) => keptRunRecords(current, ids)),
    [],
  );
  const reset = useLatestCallback((): void => {
    writeRunRecords(key, {});
    setRecords({});
  }, []);
  return { records, set, forget, keepOnly, update, reset };
}
