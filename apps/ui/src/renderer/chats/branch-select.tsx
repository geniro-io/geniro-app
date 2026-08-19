import { GitBranch } from 'lucide-react';

import type { GitInfo } from '../../shared/contracts';
import { Chip } from '../components/ui/chip';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

/**
 * Sentinel for {@link BranchValueSelect}'s "no opinion" row. A git refname is
 * never empty, so no real branch can collide with it.
 */
const ANY_BRANCH = '';

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
          ? 'Uncommitted changes — commit or stash them before switching branch'
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
      groups={[{ items: info.branches.map((b) => ({ value: b, label: b })) }]}
      onValueChange={onSwitch}
    />
  );
}

/**
 * A branch chip that RECORDS a name instead of checking it out — what a saved
 * run configuration stores.
 *
 * Kept in this file beside {@link BranchSelect} rather than folded into it: the
 * two answer different questions and would need a mode flag to share one body.
 * This one's value is the stored choice (which may name a branch the folder is
 * not on, and which may be null), while `BranchSelect`'s is the live checkout;
 * this one offers a "whatever is checked out" row, which the live control must
 * never have. They live in one file so the pair is discoverable together and a
 * reader deciding between them sees both — NOT because co-location shares
 * anything: the icon, width and not-a-repo guard are duplicated literals and are
 * free to drift.
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
      // value`, so a null here matches no row — the "whatever is checked out"
      // row would carry no checkmark and the trigger would fall back to its
      // placeholder, both reading as "nothing chosen" for a real choice.
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
          // The "no opinion" row, as a sentinel rather than a null the picker
          // cannot emit — the same mechanism `DirectorySelect` uses for its
          // "Default profile" row. A branch name is a git refname, which can
          // never be the empty string, so nothing real collides with it.
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
