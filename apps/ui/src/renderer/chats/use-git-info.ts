import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitInfo } from '../../shared/contracts';
import type { BannerTone } from '../components/error-banner';

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  worktrees: [],
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
  /**
   * The worktree that already holds the branch, when THAT is why the switch was
   * refused — so the strip can offer that folder instead of describing a dead
   * end. Null for every other notice.
   *
   * The offer is the caller's to act on, not this hook's: the folder a run uses
   * is composer state, and a hook over one directory cannot move it.
   */
  useFolder: string | null;
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
  /** Re-read `dir`, or an explicit folder the caller has just switched to. */
  refresh: (target?: string) => Promise<void>;
  clearError: () => void;
} {
  const [info, setInfo] = useState<GitInfo>(NOT_A_REPO);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pulling, setPulling] = useState(false);
  /**
   * The branch a refused switch was FOR, so a later pull can retry it. A ref
   * because {@link pull} needs the value set by the switch that preceded it,
   * and — per the past bug in this file — state just written by one callback
   * is not visible to another read from closure.
   */
  const pendingSwitchTarget = useRef<string | null>(null);

  useEffect(() => {
    pendingSwitchTarget.current = null;
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
        // `?? null` rather than a bare read: this crosses the IPC boundary, so
        // an older main process — one running while the renderer reloads onto
        // new code — answers without the field, and `undefined !== null` would
        // turn every refusal into an offer to open the folder `undefined`.
        const useFolder = result.worktree ?? null;
        if (!result.ok && result.error !== null) {
          // A refusal over uncommitted work is the guard working, not a
          // failure — main tells the two apart so this does not have to guess
          // from the sentence.
          setNotice({
            message: result.error,
            // A branch another worktree holds is the same KIND of thing as the
            // dirty refusal — a guard with a way out, not a failure — so it
            // takes the warning tone rather than the red one.
            tone: result.dirty || useFolder !== null ? 'warning' : 'error',
            offerPull: result.dirty,
            useFolder,
          });
          // Only a dirty refusal is one `pull` can act on — remember the
          // branch it was FOR so a later pull retries this exact switch
          // instead of merely clearing the strip.
          pendingSwitchTarget.current = result.dirty ? branch : null;
        } else {
          pendingSwitchTarget.current = null;
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
      if (!result.ok) {
        // A failed pull REPLACES the strip with git's own reason, as an error
        // — a refused pull is a genuine dead end for this button, and
        // offering it again would be a control that has just been shown not
        // to work.
        setNotice({
          message: result.error ?? 'git pull failed',
          tone: 'error',
          offerPull: false,
          useFolder: null,
        });
        setInfo(await window.geniro.getGitInfo(dir));
        return;
      }
      const target = pendingSwitchTarget.current;
      if (target === null) {
        setNotice(null);
      } else {
        // The pull was offered to unblock a specific switch — re-run that
        // switch rather than clearing the strip, which would read as the
        // switch having gone through when the branch never moved.
        const retry = await window.geniro.switchBranch(dir, target);
        if (retry.ok) {
          pendingSwitchTarget.current = null;
          setNotice(null);
        } else if (retry.error !== null) {
          const retryFolder = retry.worktree ?? null;
          setNotice({
            message: retry.error,
            tone: retry.dirty || retryFolder !== null ? 'warning' : 'error',
            offerPull: retry.dirty,
            useFolder: retryFolder,
          });
          pendingSwitchTarget.current = retry.dirty ? target : null;
        }
      }
      setInfo(await window.geniro.getGitInfo(dir));
    } finally {
      setPulling(false);
    }
  }, [dir]);

  /**
   * Re-read a folder's git state without switching anything.
   *
   * The effect above only fires when `dir` CHANGES, so a branch moved by some
   * other path — anything that switches through the IPC directly — leaves this
   * hook painting the branch the folder was on before.
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
    notice,
    switching,
    pulling,
    switchTo,
    pull,
    refresh,
    clearError: useCallback(() => {
      // A dismissed notice must not leave a stale target for a later pull to
      // retry against — the user dismissed the guard, not just the sentence.
      pendingSwitchTarget.current = null;
      setNotice(null);
    }, []),
  };
}
