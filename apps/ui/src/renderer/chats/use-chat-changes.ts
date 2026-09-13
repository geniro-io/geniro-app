import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GitChange } from '../../shared/contracts';
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

export interface ChatChanges {
  changes: GitChange[];
  /** More files changed than one read returns — the list is real but short. */
  truncated: boolean;
  /** Why there is no answer at all, from the reader itself. */
  unavailableReason: string | null;
  /**
   * The checkout moved off the chat's starting commit, so `changes` is what is
   * uncommitted now rather than what changed since that commit.
   */
  movedOffStart: boolean;
  /** An IPC failure, which is a different thing from git having no answer. */
  error: string | null;
  loading: boolean;
  /**
   * The totals, or null until the FIRST read of this folder lands.
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
 */
export function useChatChanges(
  cwd: string | null,
  startSha: string | null,
): ChatChanges {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [unavailableReason, setReason] = useState<string | null>(null);
  const [movedOffStart, setMovedOffStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState(false);

  // Bumped on every request; a reply carrying an older one is dropped. Last to
  // RESOLVE is not last to be asked for — a slow read of the previous thread
  // landing after a fast read of this one would otherwise show the previous
  // folder's changes under this thread's name.
  const generation = useRef(0);
  const lastReadAt = useRef(0);

  const refresh = useCallback(
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
      void window.geniro
        .getChangesSince(cwd, startSha)
        .then((result) => {
          if (generation.current !== mine) {
            return;
          }
          setChanges(result.changes);
          setTruncated(result.truncated);
          setReason(result.unavailableReason);
          setMovedOffStart(result.movedOffStart);
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
    [cwd, startSha],
  );

  useEffect(() => {
    // A thread switch invalidates everything, including the "already read" flag
    // — without clearing it the incoming thread would state the previous one's
    // totals until its own read landed.
    generation.current += 1;
    setChanges([]);
    setTruncated(false);
    setReason(null);
    setMovedOffStart(false);
    setError(null);
    setRead(false);
    lastReadAt.current = 0;
    if (cwd !== null && startSha !== null) {
      refresh(true);
    }
  }, [cwd, startSha, refresh]);

  const summary = useMemo(
    () => (read ? summarizeChanges(changes) : null),
    [read, changes],
  );

  return {
    changes,
    truncated,
    unavailableReason,
    movedOffStart,
    error,
    loading,
    summary,
    refresh,
  };
}
