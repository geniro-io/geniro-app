import { useCallback, useEffect, useState } from 'react';

import type { GitInfo } from '../../shared/contracts';
import type { BannerTone } from '../components/error-banner';

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
};

/** What the composer's strip should say about git, and how loudly. */
export interface GitNotice {
  message: string;
  tone: BannerTone;
  /**
   * Offer the pull. True only for the uncommitted-work refusal: that is the one
   * state where bringing the branch up to date is both possible and the thing
   * the user was reaching for. A pull button beside "Not a git repository"
   * would be a control that cannot work.
   */
  offerPull: boolean;
}

/**
 * Git state of `dir` for the composer's branch chip, the guarded switch, and
 * the pull that keeps uncommitted work.
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
  notice: GitNotice | null;
  switching: boolean;
  pulling: boolean;
  switchTo: (branch: string) => Promise<void>;
  pull: () => Promise<void>;
  clearError: () => void;
} {
  const [info, setInfo] = useState<GitInfo>(NOT_A_REPO);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pulling, setPulling] = useState(false);

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
      setNotice(null);
      try {
        const result = await window.geniro.switchBranch(dir, branch);
        if (!result.ok && result.error !== null) {
          // A refusal over uncommitted work is the guard working, not a
          // failure — main tells the two apart so this does not have to guess
          // from the sentence.
          setNotice({
            message: result.error,
            tone: result.dirty ? 'warning' : 'error',
            offerPull: result.dirty,
          });
        }
        setInfo(await window.geniro.getGitInfo(dir));
      } finally {
        setSwitching(false);
      }
    },
    [dir],
  );

  const pull = useCallback(async (): Promise<void> => {
    if (dir === null) {
      return;
    }
    setPulling(true);
    try {
      const result = await window.geniro.pullBranch(dir);
      // A successful pull clears the strip: the branch is up to date and the
      // uncommitted work is back, so the sentence that sent the user here no
      // longer describes anything. A failed one REPLACES it with git's own
      // reason, as an error — a refused pull is a genuine dead end for this
      // button, and offering it again would be a control that has just been
      // shown not to work.
      setNotice(
        result.ok
          ? null
          : {
              message: result.error ?? 'git pull failed',
              tone: 'error',
              offerPull: false,
            },
      );
      setInfo(await window.geniro.getGitInfo(dir));
    } finally {
      setPulling(false);
    }
  }, [dir]);

  return {
    info,
    notice,
    switching,
    pulling,
    switchTo,
    pull,
    clearError: useCallback(() => setNotice(null), []),
  };
}
