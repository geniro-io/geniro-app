import { GitBranch } from 'lucide-react';

import type { GitInfo } from '../../shared/contracts';
import { Select } from '../components/ui/select';

/**
 * The composer's git-branch chip — rendered only when the working folder is a
 * repository, so a plain folder gets no dead control.
 *
 * Picking a branch switches it, but the daemon-side guard refuses over a dirty
 * tree; the chip still OPENS on a dirty tree rather than locking, because
 * seeing which branches exist is useful even when you cannot leave this one,
 * and the refusal explains itself. A detached HEAD has no branch to name, so
 * the chip says so instead of inventing one.
 */
export function BranchSelect({
  info,
  switching,
  onSwitch,
  className,
}: {
  info: GitInfo;
  /** A switch is in flight — the chip locks so two cannot overlap. */
  switching: boolean;
  onSwitch: (branch: string) => void;
  className?: string;
}): React.JSX.Element | null {
  if (!info.isRepo) {
    return null;
  }
  return (
    <Select
      variant="ghost"
      value={info.branch}
      placeholder="detached HEAD"
      searchPlaceholder="Search branches…"
      aria-label="Git branch"
      title={
        info.dirty
          ? 'Uncommitted changes — commit or stash them before switching branch'
          : 'Git branch'
      }
      disabled={switching}
      className={className}
      leadingIcon={<GitBranch />}
      groups={[{ items: info.branches.map((b) => ({ value: b, label: b })) }]}
      onValueChange={onSwitch}
    />
  );
}
