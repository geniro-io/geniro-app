import { useEffect, useState } from 'react';

/**
 * The repository a folder is a linked worktree of, or null — for the chat
 * header, which names a TASK run's repository rather than its worktree.
 *
 * A task's agent works in a worktree geniro cuts under its own data directory
 * and names by the task's id, so the header's folder chip read
 * `794addc7-273d-4924-8…` — REPORTED as "seems like it didnt take correct
 * directory". The directory was right; its name said nothing. Git knows which
 * checkout a worktree was cut from (`GitInfo.worktreeOf`), so the answer is
 * read rather than reconstructed from the task's own settings, which can have
 * changed since the run began.
 *
 * Null for a null folder, for a folder that is not a worktree, and whenever the
 * read fails — the chip then names the folder itself, as it always did.
 */
export function useWorktreeOrigin(dir: string | null): string | null {
  const [read, setRead] = useState<{ dir: string; of: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (dir === null) {
      return;
    }
    let cancelled = false;
    window.geniro
      .getGitInfo(dir)
      .then((info) => {
        if (!cancelled) {
          setRead({ dir, of: info.worktreeOf ?? null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRead({ dir, of: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Keyed by the folder it was read FOR, so a switch to another thread never
  // shows the previous thread's repository while its own read is in flight.
  return read !== null && read.dir === dir ? read.of : null;
}
