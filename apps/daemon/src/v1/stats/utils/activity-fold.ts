import type {
  ActivityTotalsWire,
  LinesIncrement,
  LineSnapshotRead,
  LinesPeak,
} from '../stats.types';
import { snapshotLineKey } from './line-keys';

/**
 * The threads' activity, folded per day and for the whole period.
 *
 * The counterpart of the spend fold in `v1/agents/utils/usage-figures.ts`, and it does
 * not share that code: spend is summed per turn, while activity counts threads, and the
 * question that differs is what a repeat means. A thread that worked on three days is
 * one active thread for the period and one on each of those days, so a period's active
 * threads are a set, not the sum of its days.
 *
 * A fact is filed under the day it happened: a thread under its creation, a pull request
 * under when it was opened, a turn under its finish, and a lines growth under the
 * snapshot that measured it.
 */

/** The facts for one day, or for the whole period, before they are rendered. */
class ActivityBucket {
  threadsCreated = 0;
  pullRequests = 0;
  /** Null until a snapshot lands here: a day nothing was measured on is not a day of zero lines. */
  linesAdded: number | null = null;
  linesRemoved: number | null = null;
  linesPartial = false;
  readonly activeRuns = new Set<string>();
  readonly workedRuns = new Set<string>();
}

/** The period's activity, folded from the facts it was given. */
export class ActivityFold {
  private readonly days = new Map<string, ActivityBucket>();
  private readonly whole = new ActivityBucket();

  /**
   * A finished turn of a thread. `measured` is whether the turn reported its own working
   * time, which is what makes the thread count toward the average.
   */
  turn(date: string, runId: string, measured: boolean): void {
    for (const bucket of this.bucketsFor(date)) {
      bucket.activeRuns.add(runId);
      if (measured) {
        bucket.workedRuns.add(runId);
      }
    }
  }

  thread(date: string): void {
    for (const bucket of this.bucketsFor(date)) {
      bucket.threadsCreated += 1;
    }
  }

  pullRequest(date: string): void {
    for (const bucket of this.bucketsFor(date)) {
      bucket.pullRequests += 1;
    }
  }

  /** The growth one snapshot recorded over the one before it, filed under that snapshot's day. */
  lines(
    date: string,
    addedDelta: number,
    removedDelta: number,
    partial: boolean,
  ): void {
    for (const bucket of this.bucketsFor(date)) {
      bucket.linesAdded = (bucket.linesAdded ?? 0) + addedDelta;
      bucket.linesRemoved = (bucket.linesRemoved ?? 0) + removedDelta;
      bucket.linesPartial = bucket.linesPartial || partial;
    }
  }

  /**
   * The whole period. `workedMs` is the spend ledger's own working-time sum for the same
   * period, which the average is taken over, so the two cannot disagree about the turns.
   */
  period(workedMs: number | null): ActivityTotalsWire {
    return toWire(this.whole, workedMs);
  }

  /** One day. A day with no facts reads as the empty figures, not as missing ones. */
  day(date: string, workedMs: number | null): ActivityTotalsWire {
    return toWire(this.days.get(date) ?? new ActivityBucket(), workedMs);
  }

  private bucketsFor(date: string): ActivityBucket[] {
    let day = this.days.get(date);
    if (!day) {
      day = new ActivityBucket();
      this.days.set(date, day);
    }
    return [day, this.whole];
  }
}

interface MeasuredLines {
  runId: string;
  lineKey: string | null;
  occurredAt: Date;
  linesAdded: number;
  linesRemoved: number;
  partial: boolean | null;
}

function isMeasured(snapshot: LineSnapshotRead): snapshot is MeasuredLines {
  return snapshot.linesAdded !== null && snapshot.linesRemoved !== null;
}

/**
 * The growth each snapshot records past the highest total its series had reached before
 * it, per series (`snapshotLineKey`: a folder and branch measured against one baseline, so
 * work several threads share in one folder is one series and is counted once).
 *
 * A series' first snapshot in the period is measured from `peaks`, the highest total it
 * reached BEFORE the period, or from zero when it has none. Only growth past the highest
 * total counts, so a total that falls back to an earlier figure (a revert, a branch reset)
 * adds nothing, and the lines it falls back over are not counted again when it rises. A
 * snapshot with a null count was never measured, so it is skipped and changes nothing.
 */
export function linesIncrements(
  snapshots: readonly LineSnapshotRead[],
  peaks: ReadonlyMap<string, LinesPeak>,
): LinesIncrement[] {
  const bySeries = new Map<string, MeasuredLines[]>();
  for (const snapshot of snapshots) {
    if (!isMeasured(snapshot)) {
      continue;
    }
    const key = snapshotLineKey(snapshot);
    const list = bySeries.get(key) ?? [];
    list.push(snapshot);
    bySeries.set(key, list);
  }

  const increments: LinesIncrement[] = [];
  for (const [key, list] of bySeries) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const peak = peaks.get(key);
    let highestAdded = peak?.linesAdded ?? 0;
    let highestRemoved = peak?.linesRemoved ?? 0;
    for (const current of list) {
      increments.push({
        key,
        occurredAt: current.occurredAt,
        addedDelta: Math.max(0, current.linesAdded - highestAdded),
        removedDelta: Math.max(0, current.linesRemoved - highestRemoved),
        partial: current.partial === true,
      });
      highestAdded = Math.max(highestAdded, current.linesAdded);
      highestRemoved = Math.max(highestRemoved, current.linesRemoved);
    }
  }
  return increments;
}

function toWire(
  bucket: ActivityBucket,
  workedMs: number | null,
): ActivityTotalsWire {
  const threadsWithWorkedTime = bucket.workedRuns.size;
  return {
    threadsCreated: bucket.threadsCreated,
    pullRequests: bucket.pullRequests,
    linesAdded: bucket.linesAdded,
    linesRemoved: bucket.linesRemoved,
    linesPartial: bucket.linesPartial,
    activeThreads: bucket.activeRuns.size,
    threadsWithWorkedTime,
    avgWorkedMs:
      workedMs === null || threadsWithWorkedTime === 0
        ? null
        : workedMs / threadsWithWorkedTime,
  };
}
