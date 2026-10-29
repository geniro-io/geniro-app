import { useEffect, useMemo, useRef, useState } from 'react';

import type { GitChange, GitChanges } from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';
import { type ChangesSummary, summarizeChanges } from './changes-tree';

/**
 * How long an automatic re-read is skipped for.
 *
 * The trigger is a turn SETTLING, and a chat routinely settles several turns in
 * a minute — a delegate reporting back opens a continuation turn of its own, so
 * the ending is not rare. Each read is a real `git diff` over the branch, so
 * without a floor a busy thread would spend most of its life running one. An
 * explicit refresh (opening the dialog) ignores the floor, which is the whole
 * difference between "keep this roughly current" and "I am looking at it now".
 */
const CHANGES_FRESHNESS_MS = 15_000;

/** What changed in one of the thread's work folders other than its own. */
export interface WorkFolderChanges {
  folder: string;
  changes: GitChange[];
}

export interface ChatChanges {
  /** The run folder's own changes. */
  changes: GitChange[];
  /**
   * The other folders the thread's agents worked in that hold changes — a
   * worktree one of them made — each read against the same start. Apart from
   * `changes` because paths are repository-relative and collide across them.
   */
  elsewhere: WorkFolderChanges[];
  /** More files changed than one read returns — the list is real but short. */
  truncated: boolean;
  /** Why there is no answer at all, from the reader itself. */
  unavailableReason: string | null;
  /**
   * The checkout moved off the chat's starting commit, so `changes` is what is
   * uncommitted now rather than what changed since that commit.
   */
  movedOffStart: boolean;
  /**
   * What `changes` is measured against instead of the start, when the checkout
   * shares newer history with the remote than the start — null otherwise.
   */
  upstreamBase: GitChanges['upstreamBase'];
  /** An IPC failure, which is a different thing from git having no answer. */
  error: string | null;
  loading: boolean;
  /**
   * The totals over `changes` and `elsewhere` together, or null until the
   * FIRST read of this folder lands.
   *
   * Null and `{files: 0}` are different states and the difference is visible:
   * null is "not read yet", zero is "read, and nothing has changed". A chip that
   * drew `0 files` for the first is claiming a measurement nobody took.
   */
  summary: ChangesSummary | null;
  /** Read again. `force` ignores {@link CHANGES_FRESHNESS_MS}. */
  refresh: (force?: boolean) => void;
}

/**
 * What the run's folder holds now that it did not at the chat's starting commit.
 *
 * ONE read serves both the header chip and the dialog, and that is the reason
 * this is a hook rather than state inside the dialog. The dialog used to read on
 * every open and own the result, which is fine while the only consumer is the
 * dialog — a chip that STATES the figures needs them before anything is opened,
 * and a second reader would mean two `git diff` runs whose answers could differ
 * by whatever the agent wrote in between.
 *
 * It is READ ON PURPOSE rather than polled. A poll would run git on a timer for
 * the life of every open thread; the two moments the answer can have changed are
 * the thread being opened and a turn ending, and the caller drives both. That is
 * the same shape `use-pull-requests.ts` uses for the same reason, freshness
 * floor included.
 *
 * `workFolders` are the other folders the thread's agents worked in
 * (`useRunWorkFolders`), read in the same pass against the same start, since
 * an agent that commits in a worktree of its own leaves `cwd` untouched.
 */
export function useChatChanges(
  cwd: string | null,
  startSha: string | null,
  workFolders: readonly string[] = [],
): ChatChanges {
  // Callers rebuild the array every render; the key is what stays stable.
  const foldersKey = workFolders.join('\0');
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [elsewhere, setElsewhere] = useState<WorkFolderChanges[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [unavailableReason, setReason] = useState<string | null>(null);
  const [movedOffStart, setMovedOffStart] = useState(false);
  const [upstreamBase, setUpstreamBase] =
    useState<GitChanges['upstreamBase']>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState(false);

  // Bumped on every request; a reply carrying an older one is dropped. Last to
  // RESOLVE is not last to be asked for — a slow read of the previous thread
  // landing after a fast read of this one would otherwise show the previous
  // folder's changes under this thread's name.
  const generation = useRef(0);
  const lastReadAt = useRef(0);

  const refresh = useLatestCallback(
    (force = false): void => {
      if (cwd === null || startSha === null) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastReadAt.current < CHANGES_FRESHNESS_MS) {
        return;
      }
      lastReadAt.current = now;
      const mine = (generation.current += 1);
      setLoading(true);
      setError(null);
      const folders = foldersKey === '' ? [] : foldersKey.split('\0');
      void Promise.all([
        window.geniro.getChangesSince(cwd, startSha),
        Promise.all(
          folders.map((folder) =>
            window.geniro.getChangesSince(folder, startSha, true).then(
              (result) =>
                // A worktree removed since it was listed, or one git cannot
                // read (an empty list with a reason), simply has nothing to
                // add — the run folder's own reading is the one whose failure
                // the dialog explains.
                result.changes.length > 0
                  ? {
                      entry: { folder, changes: result.changes },
                      truncated: result.truncated,
                    }
                  : null,
              () => null,
            ),
          ),
        ),
      ])
        .then(([result, others]) => {
          if (generation.current !== mine) {
            return;
          }
          const held = others.filter((other) => other !== null);
          setChanges(result.changes);
          setElsewhere(held.map((other) => other.entry));
          setTruncated(
            result.truncated || held.some((other) => other.truncated),
          );
          setReason(result.unavailableReason);
          setMovedOffStart(result.movedOffStart);
          setUpstreamBase(result.upstreamBase);
          setRead(true);
        })
        .catch((err: unknown) => {
          if (generation.current === mine) {
            setError(String(err));
          }
        })
        .finally(() => {
          if (generation.current === mine) {
            setLoading(false);
          }
        });
    },
    [cwd, startSha, foldersKey],
  );

  useEffect(() => {
    // A thread switch invalidates everything, including the "already read" flag
    // — without clearing it the incoming thread would state the previous one's
    // totals until its own read landed.
    generation.current += 1;
    setChanges([]);
    setElsewhere([]);
    setTruncated(false);
    setReason(null);
    setMovedOffStart(false);
    setUpstreamBase(null);
    setError(null);
    setRead(false);
    lastReadAt.current = 0;
  }, [cwd, startSha]);

  // Apart from the reset above, and after it: a work folder found later re-reads
  // WITHOUT clearing, so the chip keeps its figures until the wider ones land.
  useEffect(() => {
    if (cwd !== null && startSha !== null) {
      refresh(true);
    }
  }, [cwd, startSha, refresh]);

  // Only folders the caller still names: two threads in one folder share the
  // reset key above, and the previous one's worktree must not stand under the
  // next until its own read lands.
  const shown = useMemo(() => {
    const current = new Set(foldersKey === '' ? [] : foldersKey.split('\0'));
    return elsewhere.filter((held) => current.has(held.folder));
  }, [elsewhere, foldersKey]);

  const summary = useMemo(
    () =>
      read
        ? summarizeChanges([
            ...changes,
            ...shown.flatMap((folder) => folder.changes),
          ])
        : null,
    [read, changes, shown],
  );

  return {
    changes,
    elsewhere: shown,
    truncated,
    unavailableReason,
    movedOffStart,
    upstreamBase,
    error,
    loading,
    summary,
    refresh,
  };
}
