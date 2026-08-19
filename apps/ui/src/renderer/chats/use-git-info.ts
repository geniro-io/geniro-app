import { useCallback, useEffect, useState } from 'react';

import type { GitInfo } from '../../shared/contracts';

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
};

/**
 * Git state of `dir` for the composer's branch chip, plus the guarded switch.
 *
 * The chip is absent for a plain folder, so the hook reports `isRepo: false`
 * for a null dir and while the first read is in flight — a chip that appeared
 * and then vanished would be worse than one that arrives a beat late.
 *
 * A switch re-reads the state afterwards on EITHER outcome: on success the
 * branch changed, and on refusal the dirty flag the chip shows is exactly what
 * the user needs to see to understand the refusal.
 */
export function useGitInfo(dir: string | null): {
  info: GitInfo;
  error: string | null;
  switching: boolean;
  switchTo: (branch: string) => Promise<void>;
  /** Re-read `dir`, or an explicit folder the caller has just switched to. */
  refresh: (target?: string) => Promise<void>;
  clearError: () => void;
} {
  const [info, setInfo] = useState<GitInfo>(NOT_A_REPO);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (dir === null) {
      setInfo(NOT_A_REPO);
      return;
    }
    let cancelled = false;
    void window.geniro.getGitInfo(dir).then((next) => {
      // A folder switch while this read was in flight must not paint the OLD
      // folder's branch onto the new one's chip.
      if (!cancelled) {
        setInfo(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const switchTo = useCallback(
    async (branch: string): Promise<void> => {
      if (dir === null) {
        return;
      }
      setSwitching(true);
      setError(null);
      try {
        const result = await window.geniro.switchBranch(dir, branch);
        if (!result.ok) {
          setError(result.error);
        }
        setInfo(await window.geniro.getGitInfo(dir));
      } finally {
        setSwitching(false);
      }
    },
    [dir],
  );

  /**
   * Re-read a folder's git state without switching anything.
   *
   * The effect above only fires when `dir` CHANGES, so a branch moved by some
   * other path — applying a saved run configuration, which switches through the
   * IPC directly — leaves this hook painting the branch the folder was on
   * before. When the configuration names the folder already selected, `dir`
   * does not change at all and nothing would refetch.
   *
   * **The directory is a PARAMETER, not read from the closure.** A caller that
   * has just changed the folder is the main reason to call this, and React
   * state is not visible to the callback that set it — reading `dir` here would
   * refetch the folder the app was on BEFORE the apply, and (because this runs
   * after a `git switch` round trip) land after the effect's read for the new
   * one, overwriting the correct answer with the previous repository's.
   */
  const refresh = useCallback(
    async (target?: string): Promise<void> => {
      // An explicit target is the caller ASSERTING which folder is now current
      // — it is passed precisely because the state change that would tell this
      // hook has not committed yet, so it is applied unconditionally. The
      // effect above re-reads the same folder when that state does land; this
      // one runs later (it waits on a real `git switch`) and is the one whose
      // answer is post-switch.
      const at = target ?? dir;
      if (at === null) {
        return;
      }
      setInfo(await window.geniro.getGitInfo(at));
    },
    [dir],
  );

  return {
    info,
    error,
    switching,
    switchTo,
    refresh,
    clearError: useCallback(() => setError(null), []),
  };
}
