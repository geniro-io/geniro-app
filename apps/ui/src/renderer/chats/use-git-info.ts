import { useEffect, useRef, useState } from 'react';

import type { GitInfo } from '../../shared/contracts';
import type { BannerTone } from '../components/error-banner';
import { useLatestCallback } from '../components/use-latest-callback';

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  worktrees: [],
  worktreeOf: null,
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
   * The branch a dirty refusal was FOR, offered as "bring my changes along" —
   * the one move that actually reaches it without losing the work. Null for
   * every other notice.
   */
  carryTo: string | null;
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
 * the two ways out of a dirty refusal that keep uncommitted work: pull the
 * current branch, or switch and bring the work along.
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
  carrying: boolean;
  switchTo: (branch: string) => Promise<void>;
  pull: () => Promise<void>;
  /** Switch to the refused branch, taking the uncommitted work along. */
  carry: () => Promise<void>;
  /** Re-read `dir`, or an explicit folder the caller has just switched to. */
  refresh: (target?: string) => Promise<void>;
  clearError: () => void;
} {
  const [info, setInfo] = useState<GitInfo>(NOT_A_REPO);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [carrying, setCarrying] = useState(false);
  /**
   * The branch a refused switch was FOR, so {@link carry} can reach it and
   * {@link pull} can keep offering it. A ref because both need the value set by
   * the switch that preceded them, and — per the past bug in this file — state
   * just written by one callback is not visible to another read from closure.
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

  const switchTo = useLatestCallback(
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
            carryTo: result.dirty ? branch : null,
            useFolder,
          });
          // Only a dirty refusal is one the strip's offers can act on —
          // remember the branch it was FOR so "bring changes along" reaches
          // this exact branch.
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

  /**
   * Fast-forward the CURRENT branch, keeping the work.
   *
   * It never retries the refused switch: the pull puts the work back on this
   * branch, so the tree is exactly as dirty afterwards and the guard would
   * refuse again with the very sentence already on the strip — which is how
   * this button once looked like it did nothing at all. The strip instead says
   * what the pull did, and keeps the offer that does reach the picked branch.
   */
  const pull = useLatestCallback(async (): Promise<void> => {
    if (dir === null) {
      return;
    }
    setPulling(true);
    try {
      const result = await window.geniro.pullBranch(dir);
      const carryTo = pendingSwitchTarget.current;
      if (!result.ok) {
        // A failed pull REPLACES the strip with git's own reason, as an error
        // — a refused pull is a genuine dead end for this button, and
        // offering it again would be a control that has just been shown not
        // to work. Bringing the work along is a different move, still open.
        setNotice({
          message: result.error ?? 'git pull failed',
          tone: 'error',
          offerPull: false,
          carryTo,
          useFolder: null,
        });
      } else if (carryTo === null) {
        setNotice(null);
      } else {
        setNotice({
          message: `Pulled ${result.branch ?? 'this branch'} up to date and kept your changes — still not on ${carryTo}`,
          tone: 'warning',
          offerPull: false,
          carryTo,
          useFolder: null,
        });
      }
      setInfo(await window.geniro.getGitInfo(dir));
    } finally {
      setPulling(false);
    }
  }, [dir]);

  const carry = useLatestCallback(async (): Promise<void> => {
    const target = pendingSwitchTarget.current;
    if (dir === null || target === null) {
      return;
    }
    setCarrying(true);
    try {
      const result = await window.geniro.carryChangesToBranch(dir, target);
      pendingSwitchTarget.current = null;
      setNotice(
        result.ok
          ? null
          : {
              message: result.error ?? 'git switch failed',
              tone: 'error',
              offerPull: false,
              carryTo: null,
              useFolder: null,
            },
      );
      setInfo(await window.geniro.getGitInfo(dir));
    } finally {
      setCarrying(false);
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
  const refresh = useLatestCallback(
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
    carrying,
    switchTo,
    pull,
    carry,
    refresh,
    clearError: useLatestCallback(() => {
      // A dismissed notice must not leave a stale target for a later pull to
      // retry against — the user dismissed the guard, not just the sentence.
      pendingSwitchTarget.current = null;
      setNotice(null);
    }, []),
  };
}
