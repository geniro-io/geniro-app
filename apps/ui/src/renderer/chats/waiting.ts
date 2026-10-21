import { lastActivityOf } from './run-order';
import { isWorkingRunStatus, type RunStatusKind } from './run-status';

/**
 * What a thread is waiting on the user for, most urgent first:
 *
 * - `asking` — a question or approval card is open; the turn cannot advance.
 * - `failed` — the turn failed (the CLI exiting included) and nobody has
 *   looked since. A failure the user has seen is no longer news.
 * - `unseen` — a turn ended with a reply nobody has opened, and no turn has
 *   started since.
 * - `working` — nothing is owed; the agent is busy.
 *
 * Only the first three are a wait ON the user, which is what the jump shortcut
 * cycles through; `working` ranks last so a list of every thread still has an
 * order.
 */
export type WaitState = 'asking' | 'failed' | 'unseen' | 'working';

const WAIT_RANK: Record<WaitState, number> = {
  asking: 0,
  failed: 1,
  unseen: 2,
  working: 3,
};

/**
 * Derived from the run row's own facts, never from the loaded transcript, so a
 * thread reads the same whether or not it is the one on screen.
 */
export function waitStateOf({
  status,
  unseen,
}: {
  /** The sidebar's reading for a run nobody is looking at. */
  status: RunStatusKind;
  /** The daemon's unread mark, as `useUnseenRuns` hides it for a watched run. */
  unseen: boolean;
}): WaitState | null {
  if (status === 'needs-input') {
    return 'asking';
  }
  // Working outranks an earlier reply nobody read: the turn that reply ended
  // is over, and a mark beside the spinner saying "a turn ended" is untrue.
  if (isWorkingRunStatus(status)) {
    return 'working';
  }
  if (unseen) {
    return status === 'failed' ? 'failed' : 'unseen';
  }
  return null;
}

/** A state the user owes something to. */
export type OwedState = Exclude<WaitState, 'working'>;

/** Whether this state is one the user owes something to. */
export function waitsOnUser(state: WaitState): state is OwedState {
  return state !== 'working';
}

/**
 * Most urgent first; within a state the longest wait first. Stable, so items
 * with no `since` (a workflow node has none) keep the order they came in.
 * Items with no state sink below every ranked one, also in their own order.
 */
export function rankByUrgency<T>(
  items: readonly T[],
  stateOf: (item: T) => WaitState | null,
  sinceOf: (item: T) => string | null = () => null,
): T[] {
  const rankOf = (item: T): number => {
    const state = stateOf(item);
    return state === null ? Number.POSITIVE_INFINITY : WAIT_RANK[state];
  };
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      const aSince = sinceOf(a.item);
      const bSince = sinceOf(b.item);
      if (aSince !== null && bSince !== null && aSince !== bSince) {
        // ISO-8601 UTC strings from the daemon: lexical order is time order.
        return aSince.localeCompare(bSince);
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/** One thread's wait, as the shortcut, the status line and the board read it. */
export interface WaitReading {
  runId: string;
  state: WaitState;
  /** When the wait began — the moment the run last asked, ended or failed. */
  since: string;
}

/**
 * Every thread with a state, ranked. `since` is the daemon's `attentionAt` (the
 * last ask, completion or failure), else the thread's last activity — what a
 * working thread has to offer.
 */
export function waitReadings<
  TRun extends {
    id: string;
    attentionAt: string | null;
    lastActivityAt: string | null;
    updatedAt: string;
  },
>(
  runs: readonly TRun[],
  {
    statusOf,
    unseen,
  }: {
    statusOf: (run: TRun) => RunStatusKind;
    unseen: ReadonlySet<string>;
  },
): WaitReading[] {
  const readings: WaitReading[] = [];
  for (const run of runs) {
    const state = waitStateOf({
      status: statusOf(run),
      unseen: unseen.has(run.id),
    });
    if (state !== null) {
      readings.push({
        runId: run.id,
        state,
        since: run.attentionAt ?? lastActivityOf(run),
      });
    }
  }
  return readings.sort(compareReadings);
}

/**
 * The one order of readings: most urgent, then longest wait, then run id — a
 * TOTAL order, so "the reading after this one" means the same thing to the
 * queue and to {@link nextWaiting}, two equal moments included.
 */
function compareReadings(a: WaitReading, b: WaitReading): number {
  return (
    WAIT_RANK[a.state] - WAIT_RANK[b.state] ||
    // ISO-8601 UTC strings from the daemon: lexical order is time order.
    a.since.localeCompare(b.since) ||
    a.runId.localeCompare(b.runId)
  );
}

/**
 * The thread the jump shortcut opens: the first wait on the user ranked after
 * `cursor`, wrapping round to the head; the head when there is no cursor.
 *
 * `cursor` is where the cycle stands — the open thread's reading while it is
 * still owed, else the reading the last jump went to. A reading rather than an
 * id, because the thread a jump opened routinely LEAVES the queue: opening an
 * unread one sees it, answering an asking one sets it working. Looked up by id,
 * the next press would find nothing and start over at the head, sending the
 * user back through every unanswered approval between two replies.
 */
export function nextWaiting(
  ranked: readonly WaitReading[],
  cursor: WaitReading | null,
): WaitReading | null {
  const queue = ranked.filter((reading) => waitsOnUser(reading.state));
  return (
    (cursor === null
      ? undefined
      : queue.find((reading) => compareReadings(reading, cursor) > 0)) ??
    queue[0] ??
    null
  );
}

/** The states the status line counts, most urgent first. */
export const OWED_STATES: readonly OwedState[] = (
  Object.keys(WAIT_RANK) as WaitState[]
).filter(waitsOnUser);

/** How many threads wait on the user in each state, for the status line. */
export function waitCounts(
  ranked: readonly WaitReading[],
): Record<OwedState, number> {
  const counts = { asking: 0, failed: 0, unseen: 0 };
  for (const { state } of ranked) {
    if (waitsOnUser(state)) {
      counts[state] += 1;
    }
  }
  return counts;
}
