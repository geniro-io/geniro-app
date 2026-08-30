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

/**
 * Sentinel for {@link BranchValueSelect}'s "no opinion" row. A git refname is
 * never empty, so no real branch can collide with it.
 */
const ANY_BRANCH = '';

/**
 * The branch chip a saved run configuration is EDITED with — it records a name
 * and switches nothing.
 *
 * The distinction from {@link BranchSelect} above is the whole reason it is a
 * second component rather than a prop: that one acts on the checkout the moment
 * a row is picked, which is exactly wrong while describing a setup for later —
 * editing a configuration would check the branch out under whatever the user
 * was doing. It also has a value this one does not: "whatever is checked out",
 * a real answer that no live chip can express.
 */
export function BranchValueSelect({
  info,
  value,
  onChange,
}: {
  /** Git state of the folder the configuration points at, for the row list. */
  info: GitInfo;
  /** The recorded branch, or null to take whatever is checked out. */
  value: string | null;
  onChange: (branch: string | null) => void;
}): React.JSX.Element | null {
  if (!info.isRepo) {
    return null;
  }
  // A branch the folder no longer has is still the user's stored answer, so it
  // is added back as its own row rather than silently reading as unset — the
  // same rule the model and effort chips follow for an off-list value.
  const known = info.branches.includes(value ?? '');
  return (
    <Select
      variant="ghost"
      // The SENTINEL, not `null`: `Select` matches a row by `item.value ===
      // value`, so a null matches no row and a real choice would read as
      // "nothing chosen" — no checkmark, and the trigger on its placeholder.
      value={value ?? ANY_BRANCH}
      placeholder="branch in use"
      searchPlaceholder="Search branches…"
      aria-label="Branch this configuration checks out"
      title="Branch to switch to when this configuration is used"
      className="max-w-40"
      flexible
      leadingIcon={<GitBranch />}
      groups={[
        {
          items: [
            { value: ANY_BRANCH, label: 'Whatever is checked out' },
            ...info.branches.map((b) => ({ value: b, label: b })),
            ...(value !== null && !known ? [{ value, label: value }] : []),
          ],
        },
      ]}
      onValueChange={(next) => onChange(next === ANY_BRANCH ? null : next)}
    />
  );
}
