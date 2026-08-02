import { GitBranch } from 'lucide-react';

import type { GitInfo } from '../../shared/contracts';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

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
      // Capped rather than shrinkable. Flex sheds width in PROPORTION to each
      // item's natural size, so making this shrink too would elide a short
      // "develop" alongside the folder instead of after it. Not shrinking
      // leaves the folder — the label that tolerates elision best, its full
      // path one tooltip away — to absorb the whole squeeze, while the cap
      // still bounds a genuinely long branch name (the label truncates inside
      // it) so one can't push the row wider than the card.
      className={cn('max-w-40', className)}
      leadingIcon={<GitBranch />}
      groups={[{ items: info.branches.map((b) => ({ value: b, label: b })) }]}
      onValueChange={onSwitch}
    />
  );
}
