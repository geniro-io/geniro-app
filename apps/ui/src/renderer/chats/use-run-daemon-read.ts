import { useEffect, useState } from 'react';

export interface RunDaemonRead<T> {
  /** Which run the value was read from — see the guard below. */
  runId: string | null;
  value: T;
  /**
   * Whether a read of this run has answered (a failed one included) — what
   * tells the value a thread opened with from one arriving while it is open.
   */
  loaded: boolean;
}

/**
 * One whole-run list the open thread's panel draws, read from the DAEMON
 * rather than folded from the transcript: a thread opens on its newest page,
 * so a local fold would silently drop what was written earlier. Re-read when
 * `trigger` moves — the newest seq of the rows the list is made of, which is
 * monotonic within a thread and does not move when older history pages in.
 *
 * `read` and `empty` must keep their identity across renders (module-level
 * constants), since the read is keyed on them.
 */
export function useRunDaemonRead<Api, T>(
  api: Api | null,
  runId: string | null,
  trigger: number,
  read: (api: Api, runId: string) => Promise<T>,
  empty: T,
): RunDaemonRead<T> {
  const [state, setState] = useState<RunDaemonRead<T>>(() => ({
    runId,
    value: empty,
    loaded: false,
  }));

  useEffect(() => {
    if (api === null || runId === null) {
      setState({ runId, value: empty, loaded: false });
      return;
    }
    let cancelled = false;
    read(api, runId)
      .then((value) => {
        if (!cancelled) {
          setState({ runId, value, loaded: true });
        }
      })
      // A list that could not be read draws no section, never an error over a
      // working run: the transcript still holds every row it is made of.
      .catch(() => {
        if (!cancelled) {
          setState({ runId, value: empty, loaded: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, runId, trigger, read, empty]);

  // A thread switch renders once before the effect replaces the value, so
  // without this the new thread would show the previous run's list.
  return state.runId === runId ? state : { runId, value: empty, loaded: false };
}
