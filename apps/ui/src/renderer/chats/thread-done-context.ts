import { createContext } from 'react';

import { readThreadMessageRow } from './thread-message-payload';

/** The seq of the newest row announcing each thread as done. */
export type ThreadDoneNewest = ReadonlyMap<string, number>;

/** Provided where the transcript's rows are known; null draws every Done entry. */
export const ThreadDoneNewestContext = createContext<ThreadDoneNewest | null>(
  null,
);

/** What each thread reported, by run id, read live from the command center's board. */
export type ThreadReports = ReadonlyMap<string, string>;

export const ThreadReportsContext = createContext<ThreadReports | null>(null);

/** When each thread the manager chat's Done rows name was archived, null while it is not; a run not read yet is absent. */
export type ThreadArchived = ReadonlyMap<string, string | null>;

export const ThreadArchivedContext = createContext<ThreadArchived | null>(null);

export function newestDoneSeqByRun(
  rows: readonly { seq: number; payload?: unknown }[],
): ThreadDoneNewest {
  const newest = new Map<string, number>();
  for (const row of rows) {
    const read = readThreadMessageRow(row.payload);
    if (read === null || read.kind !== 'done') {
      continue;
    }
    for (const done of read.done) {
      if ((newest.get(done.runId) ?? -1) < row.seq) {
        newest.set(done.runId, row.seq);
      }
    }
  }
  return newest;
}

/** Whether the Done entry of `runId` in the row at `seq` is the one to draw. */
export function isNewestDone(
  newest: ThreadDoneNewest | null,
  runId: string,
  seq: number,
): boolean {
  const latest = newest?.get(runId);
  return latest === undefined || latest === seq;
}
