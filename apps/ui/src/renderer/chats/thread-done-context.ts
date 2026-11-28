import { createContext } from 'react';

import { readThreadMessageRow } from './thread-message-payload';
import type { ManagerNotices } from './use-manager-notices';

/** The seq of the newest row announcing each thread as done. */
export type ThreadDoneNewest = ReadonlyMap<string, number>;

/** Provided where the transcript's rows are known; null draws every Done entry. */
export const ThreadDoneNewestContext = createContext<ThreadDoneNewest | null>(
  null,
);

/** How far the user dismissed each thread's finish, kept by the daemon for every device. */
export interface ThreadDoneDismissals {
  /** Per thread, the seq of the newest Done row dismissed. */
  through: ReadonlyMap<string, number>;
  /** Per thread, the board's `finishKey` of the finish dismissed. */
  finishes: ReadonlyMap<string, string | null>;
  /** A Done row's seq, or null to dismiss the finish itself, as the gallery does. */
  dismiss: (runId: string, seq: number | null) => void;
}

/** Provided in the command center's manager chat; null offers no Dismiss. */
export const ThreadDoneDismissalsContext =
  createContext<ThreadDoneDismissals | null>(null);

/** Each finished thread's finish, by run id, as the command center's board names it. */
export type ThreadFinishKeys = ReadonlyMap<string, string>;

export const ThreadFinishKeysContext = createContext<ThreadFinishKeys | null>(
  null,
);

/** Whether the finish `finishKey` names of `runId` is the one the user dismissed. */
export function isFinishDismissed(
  dismissals: ThreadDoneDismissals | null,
  runId: string,
  finishKey: string | null,
): boolean {
  return finishKey !== null && dismissals?.finishes.get(runId) === finishKey;
}

/**
 * Whether the Done entry of `runId` in the row at `seq` was dismissed: a row
 * at or below the dismissed seq, or one announcing the finish the board names
 * now (`finishKey`) when that finish is the one dismissed.
 */
export function isDoneDismissed(
  dismissals: ThreadDoneDismissals | null,
  runId: string,
  seq: number,
  finishKey: string | null = null,
): boolean {
  return (
    (dismissals?.through.get(runId) ?? 0) >= seq ||
    isFinishDismissed(dismissals, runId, finishKey)
  );
}

/** The manager's Done dismissals, a Dismiss recording the finish the board names now. */
export function threadDoneDismissalsOf(
  notices: ManagerNotices,
  finishKeys: ThreadFinishKeys | null,
): ThreadDoneDismissals {
  return {
    through: notices.doneDismissedThrough,
    finishes: notices.doneDismissedFinish,
    dismiss: (runId, seq) =>
      notices.dismissDone(runId, seq, finishKeys?.get(runId) ?? null),
  };
}

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
