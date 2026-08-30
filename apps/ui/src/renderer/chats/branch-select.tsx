import { GitBranch } from 'lucide-react';

import type { GitInfo } from '../../shared/contracts';
import { Chip } from '../components/ui/chip';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

/**
 * The composer's git-branch chip — rendered only when the working folder is a
 * repository, so a plain folder gets no dead control.
 *
 * Before a run starts, picking a branch switches it; the daemon-side guard
 * refuses over a dirty tree, and the chip still OPENS on a dirty tree rather
 * than locking, because seeing which branches exist is useful even when you
 * cannot leave this one, and the refusal explains itself. A detached HEAD has
 * no branch to name, so the chip says so instead of inventing one.
 *
 * Once a run EXISTS the chip is `readOnly`: a session's work belongs to the
 * branch it started on, and switching underneath a live transcript would leave
 * every turn in it describing a tree that is no longer checked out.
 */
export function BranchSelect(
  props: {
    info: GitInfo;
    className?: string;
  } & (
    | {
        /** State the branch, do not offer to change it. */
        readOnly: true;
        switching?: never;
        onSwitch?: never;
      }
    | {
        readOnly?: false;
        /** A switch is in flight — the chip locks so two cannot overlap. */
        switching: boolean;
        onSwitch: (branch: string) => void;
      }
  ),
): React.JSX.Element | null {
  const { info, className } = props;
  if (!info.isRepo) {
    return null;
  }
  if (props.readOnly) {
    // A static Chip, so it carries no chevron: the chevron is what tells a
    // picker from a statement, and one here would promise a menu.
    return (
      <Chip
        title={`On branch ${info.branch ?? 'detached HEAD'} — a run stays on the branch it started on`}
        className={cn('max-w-40 min-w-0 shrink', className)}>
        <GitBranch />
        <span className="truncate">{info.branch ?? 'detached HEAD'}</span>
      </Chip>
    );
  }
  const { switching, onSwitch } = props;
  return (
    <Select
      variant="ghost"
      value={info.branch}
      placeholder="detached HEAD"
      searchPlaceholder="Search branches…"
      aria-label="Git branch"
      title={
        info.dirty
          ? 'Uncommitted changes — the switch will be refused, and offer to pull instead'
          : 'Git branch'
      }
      disabled={switching}
      // Capped AND shrinkable — see the same pairing on `DirectorySelect`, and
      // the reason it changed there. A branch name is user data, so this is one
      // of the chips that should narrow when the composer row runs short rather
      // than let a neighbour wrap.
      className={cn('max-w-40', className)}
      flexible
      leadingIcon={<GitBranch />}
      groups={[
        {
          items: info.branches.map((b) => {
            const held = info.worktrees.find((entry) => entry.branch === b);
            return {
              value: b,
              label: b,
              // Named where it is, and still PICKABLE. git will not check it
              // out twice, so the switch is refused either way — but a disabled
              // row would be a dead end, where picking it produces the strip's
              // offer to run in the folder that already has it. The leaf alone:
              // the full path is what the offer states, and a menu row this
              // wide would push every branch name out of view.
              ...(held ? { hint: `in ${leafOf(held.path)}` } : {}),
            };
          }),
        },
      ]}
      onValueChange={onSwitch}
    />
  );
}

/** The last segment of a path — what a worktree is recognised by. */
function leafOf(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}
