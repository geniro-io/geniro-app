import { asRecord } from '../../agents/utils/json-util';

export interface ManagerAnnounced {
  runIds: Set<string>;
  itemIds: Set<string>;
}

/** The threads and waiting items the payloads of a manager's host rows already announce. */
export function announcedIn(payloads: readonly unknown[]): ManagerAnnounced {
  const runIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const payload of payloads) {
    const record = asRecord(payload);
    const done = record?.threadDone;
    if (Array.isArray(done)) {
      for (const entry of done) {
        const runId = asRecord(entry)?.runId;
        if (typeof runId === 'string') {
          runIds.add(runId);
        }
      }
    }
    const items = asRecord(record?.waitingItems)?.items;
    if (Array.isArray(items)) {
      for (const entry of items) {
        const id = asRecord(entry)?.id;
        if (typeof id === 'string') {
          itemIds.add(id);
        }
      }
    }
  }
  return { runIds, itemIds };
}
