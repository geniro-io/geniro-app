import { useCallback, useEffect, useState } from 'react';

import type { GitChange, GitChangeStatus } from '../../shared/contracts';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { SearchResultList } from '../components/search-panel';
import { Dialog } from '../components/ui/dialog';
import { UnifiedDiff } from './diff-view';

/**
 * What each status is CALLED, and how it is toned.
 *
 * `untracked` says "new · not staged" rather than borrowing `added`'s word,
 * because the two are different facts about the tree: an added file is in the
 * index and a checkout carries it, while this one exists only in the working
 * directory and is the case a plain `git diff` loses.
 */
const STATUS_META: Record<
  GitChangeStatus,
  { label: string; className: string }
> = {
  added: { label: 'added', className: 'text-success' },
  modified: { label: 'modified', className: 'text-muted-foreground' },
  deleted: { label: 'deleted', className: 'text-destructive' },
  renamed: { label: 'renamed', className: 'text-muted-foreground' },
  copied: { label: 'copied', className: 'text-muted-foreground' },
  untracked: { label: 'new · not staged', className: 'text-success' },
};

function ChangeRow({ change }: { change: GitChange }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[change.status];
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left hover:bg-sidebar-accent"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        {/* The path is what identifies the row, so it is what gets the width
            and what breaks — a long path is one unbroken token with nothing to
            wrap at. */}
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">
          {change.path}
        </span>
        <span className={`shrink-0 text-xs ${meta.className}`}>
          {meta.label}
        </span>
      </button>
      {open ? (
        change.diff === null ? (
          <div className="px-3 pb-3">
            <EmptyState>
              No diff for this file — it is either too large for one read or git
              could not produce one.
            </EmptyState>
          </div>
        ) : (
          <div className="px-3 pb-3">
            <UnifiedDiff diff={change.diff} />
          </div>
        )
      ) : null}
    </li>
  );
}

/**
 * What the folder holds now that it did not when this conversation started.
 *
 * READ-ONLY, and deliberately offers no revert: undoing a change is done in the
 * user's own git, where they can see what they are undoing and where an `undo`
 * is itself recorded. A button here would be a one-click discard of work an
 * agent may have spent an hour on, from a view whose whole purpose is that the
 * user has not read it yet.
 *
 * Re-read on every OPEN rather than polled: the agent is writing to this tree
 * while the chat runs, so what is on screen is a snapshot, and the honest way to
 * refresh it is to open it again.
 */
export function ChatChangesDialog({
  open,
  cwd,
  startSha,
  onClose,
}: {
  open: boolean;
  /** The run's folder; null for a run that has none. */
  cwd: string | null;
  /** The commit the chat started at; null when nothing was stamped. */
  startSha: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    if (cwd === null || startSha === null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.geniro.getChangesSince(cwd, startSha);
      setChanges(result.changes);
      setTruncated(result.truncated);
      setReason(result.unavailableReason);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, startSha]);

  useEffect(() => {
    if (open) {
      void read();
    }
  }, [open, read]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Changed since this chat started"
      className="h-[min(48rem,100%)] w-[min(60rem,calc(100vw-3rem))] max-w-none">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <p className="shrink-0 text-sm text-muted-foreground">
          {startSha === null
            ? 'This chat was not stamped with a commit, so there is nothing to compare against.'
            : `Working tree against ${startSha.slice(0, 12)} — including files that were created and never added. Read-only: undo anything here in your own git.`}
        </p>

        {error ? <ErrorText className="shrink-0">{error}</ErrorText> : null}

        {/* The shared list — `truncated` is what its partial note says here. */}
        <SearchResultList
          loading={loading}
          loadingLabel="Reading the folder…"
          unavailableReason={reason}
          partialReason={
            truncated
              ? 'More files changed than this view lists — showing the first of them by path.'
              : null
          }
          isEmpty={changes.length === 0}
          empty={
            <EmptyState>
              Nothing has changed in this folder since the chat started.
            </EmptyState>
          }>
          <ul className="m-0 flex list-none flex-col p-0">
            {changes.map((change) => (
              // Keyed on the pair: one path can appear twice — a file removed
              // from tracking is a `D` row from the diff AND an untracked row
              // from `ls-files`, which is a duplicate key and two rows whose
              // expand state can swap.
              <ChangeRow
                key={`${change.status}:${change.path}`}
                change={change}
              />
            ))}
          </ul>
        </SearchResultList>
      </div>
    </Dialog>
  );
}
