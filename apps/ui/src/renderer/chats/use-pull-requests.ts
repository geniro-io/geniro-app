import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PullRequestsResult } from '../../shared/contracts';

/**
 * The answer for a folder nothing has read yet — deliberately the same empty
 * shape a failed read returns (see {@link PullRequestsResult}), so no surface
 * has to tell "not yet" from "nothing to show".
 */
const UNREAD: PullRequestsResult = {
  branch: null,
  originOwner: null,
  pullRequests: [],
};

/**
 * How long a folder's answer counts as fresh when the window regains focus.
 *
 * A refresh costs three `gh` queries and two `git` reads PER FOLDER, and
 * alt-tabbing between an editor and this app is the normal rhythm — so without
 * a floor, ordinary use spends a burst of authenticated GitHub traffic every few
 * seconds re-reading folders whose pull requests cannot have changed. An
 * explicit {@link PullRequestStore.refresh} ignores this: it is asked for
 * because something DID change.
 */
const REFRESH_TTL_MS = 5 * 60_000;

export interface PullRequestStore {
  byDir: ReadonlyMap<string, PullRequestsResult>;
  /**
   * Re-read one folder now.
   *
   * The window-focus refresh cannot cover a branch switch made INSIDE the app:
   * the window never lost focus, so nothing would fire, and the composer band
   * would go on naming the previous branch's pull request.
   */
  refresh: (dir: string) => void;
}

/**
 * Pull requests for several folders at once, read once per folder.
 *
 * A LIST rather than one folder per caller, because the sidebar draws a row per
 * thread and threads routinely share a checkout: a per-row read would spawn one
 * `gh` process — a network round trip — per row to answer one question. The
 * owner passes every folder on screen and hands each surface what it needs, so
 * the rows themselves stay plain memoized components.
 *
 * Reads are SEQUENTIAL. Each one is a process talking to GitHub, and a user with
 * a dozen checkouts in their history would otherwise open a dozen at once on the
 * first paint of the chat list.
 */
export function usePullRequests(dirs: readonly string[]): PullRequestStore {
  const [byDir, setByDir] = useState<ReadonlyMap<string, PullRequestsResult>>(
    new Map(),
  );
  /**
   * Folders a read has already been started for. A ref, not state: it must be
   * visible to the next pass in the SAME commit, and writing it must not
   * re-render every row.
   */
  const started = useRef(new Set<string>());
  /** A focus refresh already walking the list; a second must not stack on it. */
  const refreshing = useRef(false);
  /** The newest read asked for per folder — see the supersede check in `read`. */
  const issued = useRef(new Map<string, number>());
  /** When each folder last answered, for {@link REFRESH_TTL_MS}. */
  const readAt = useRef(new Map<string, number>());

  const read = useCallback(async (dir: string): Promise<void> => {
    const generation = (issued.current.get(dir) ?? 0) + 1;
    issued.current.set(dir, generation);
    try {
      const result = await window.geniro.getPullRequests(dir);
      // Last to RESOLVE is not last to be asked for. A focus sweep's read can
      // still be in flight when a branch switch fires `refresh` for the same
      // folder; without this the older reply lands second and reinstates the
      // pre-switch branch, which is the exact staleness `refresh` exists to fix.
      if (issued.current.get(dir) === generation) {
        // Only a read that ANSWERED starts the freshness clock. Main folds every
        // failure into the same empty shape, so stamping one would pin "no pull
        // requests" for the whole floor with no user-reachable retry — a network
        // blip would cost five minutes of silence, where before the floor the
        // next focus recovered.
        if (result.branch !== null || result.pullRequests.length > 0) {
          readAt.current.set(dir, Date.now());
        }
        setByDir((previous) => new Map(previous).set(dir, result));
      }
    } catch {
      // One folder's failure must not cost every other folder its answer. An
      // uncaught rejection here would abort the sequential loop, leaving the
      // folders after it unread AND marked started, so nothing would retry them.
      started.current.delete(dir);
    }
  }, []);

  // `dirs` is a fresh array on every render of the owner, so both effects below
  // are keyed on its CONTENT — keyed on the array itself they would re-run on
  // every keystroke in the composer.
  const key = dirs.join('\n');
  const wanted = useMemo(
    () => (key === '' ? [] : [...new Set(key.split('\n'))]),
    [key],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const dir of wanted) {
        if (cancelled) {
          return;
        }
        if (started.current.has(dir)) {
          continue;
        }
        // Marked immediately before its OWN read, never for the whole batch up
        // front: a cancel part-way through would otherwise leave every folder
        // after it marked started and so never read again.
        started.current.add(dir);
        await read(dir);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wanted, read]);

  useEffect(() => {
    // Returning to the window is when the answer may have changed: a pull
    // request is opened, merged or closed on GitHub, which is somewhere else by
    // definition. Bounded to the folders currently on screen — `started` only
    // ever grows, so refreshing that instead would re-read every checkout the
    // session had ever seen, on every focus, forever.
    const onFocus = (): void => {
      if (refreshing.current) {
        return;
      }
      refreshing.current = true;
      void (async () => {
        try {
          for (const dir of wanted) {
            const last = readAt.current.get(dir);
            if (last !== undefined && Date.now() - last < REFRESH_TTL_MS) {
              continue;
            }
            await read(dir);
          }
        } finally {
          refreshing.current = false;
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [wanted, read]);

  const refresh = useCallback(
    (dir: string): void => {
      started.current.add(dir);
      void read(dir);
    },
    [read],
  );

  return useMemo(() => ({ byDir, refresh }), [byDir, refresh]);
}

/** One folder's entry, or the unread shape when it has none. */
export function pullRequestsIn(
  byDir: ReadonlyMap<string, PullRequestsResult>,
  dir: string | null,
): PullRequestsResult {
  return (dir === null ? undefined : byDir.get(dir)) ?? UNREAD;
}
