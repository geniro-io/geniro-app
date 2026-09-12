import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { GitChange, GitChangeStatus } from '../../shared/contracts';
import { DiffFigures } from '../components/diff-figures';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { SearchResultList } from '../components/search-panel';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../components/ui/utils';
import { buildChangesTree, type ChangeTreeNode } from './changes-tree';
import { UnifiedDiff } from './diff-view';

/**
 * What each status is CALLED, and how it is toned.
 *
 * `untracked` says "new · not staged" rather than borrowing `added`'s word,
 * because the two are different facts about the tree: an added file is in the
 * index and a checkout carries it, while this one exists only in the working
 * directory and is the case a plain `git diff` loses.
 *
 * **`modified` is the one status left MUTED, and that is the point of the set
 * rather than an omission.** On any real branch it is most of the list — 60 of
 * the 67 rows on the change this view was built in — so giving it a colour
 * paints the whole dialog one hue and leaves the reader exactly where they
 * started. Colour here marks what is NOTABLE: a file that appeared, one that
 * went, one that moved. That is the same rule the Stats page states for its
 * breakdowns, where a repeated colour is what a reader takes to mean something.
 */
const STATUS_META: Record<
  GitChangeStatus,
  { label: string; className: string }
> = {
  added: { label: 'added', className: 'text-success' },
  modified: { label: 'modified', className: 'text-muted-foreground' },
  deleted: { label: 'deleted', className: 'text-destructive' },
  renamed: { label: 'renamed', className: 'text-warning' },
  copied: { label: 'copied', className: 'text-warning' },
  untracked: { label: 'new · not staged', className: 'text-success' },
};

/** Each level's own indent, in the tree's monospace column. */
const INDENT_REM = 0.85;

/** The tree's rows are a LIST, so their figures take the aligned columns. */
const LineCounts = ({
  added,
  removed,
}: {
  added: number | null;
  removed: number | null;
}): React.JSX.Element | null => (
  <DiffFigures added={added} removed={removed} layout="columns" />
);

function FileRow({
  change,
  name,
  depth,
}: {
  change: GitChange;
  name: string;
  depth: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[change.status];
  return (
    // NO hairline between rows, deliberately. A `border-b` on file rows alone
    // draws a line between two sibling FILES and none between a file and the
    // directory after it — which is `last:border-b-0` doing exactly what it says
    // inside each nested list, and reads on screen as lines scattered at random.
    // The indent and the directory rows are the structure here; a rule that
    // appears on some boundaries and not others is worse than none.
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer items-baseline gap-2 py-1.5 pr-3 text-left hover:bg-sidebar-accent"
        style={{ paddingLeft: `${0.75 + depth * INDENT_REM}rem` }}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        {/* The NAME now, not the path — the directories above carry the rest,
            which is the whole reason for the tree. It still breaks rather than
            truncates: a filename is one unbroken token with nothing to wrap at,
            and the end of it is as identifying as the start. */}
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">
          {name}
        </span>
        {/* Status BEFORE the counts, so the counts are the last column on a file
            row as they are on a directory row and the two line up. */}
        <span
          className={cn('w-28 shrink-0 text-right text-xs', meta.className)}>
          {meta.label}
        </span>
        <LineCounts added={change.added} removed={change.removed} />
      </button>
      {open ? (
        <div
          className="pr-3 pb-3"
          style={{ paddingLeft: `${0.75 + depth * INDENT_REM}rem` }}>
          {change.diff === null ? (
            <EmptyState>
              No diff for this file — it is either too large for one read or git
              could not produce one.
            </EmptyState>
          ) : (
            <UnifiedDiff diff={change.diff} />
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * One directory, with what changed under it rolled up onto its own row.
 *
 * Open by DEFAULT: this dialog is opened to read what an agent did, so a tree
 * that starts shut answers that with a row of folder names and makes the reader
 * click to learn anything. The fold is for putting a finished area away, not for
 * getting in.
 */
function DirRow({
  node,
  depth,
}: {
  node: Extract<ChangeTreeNode, { type: 'dir' }>;
  depth: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer items-baseline gap-2 py-1.5 pr-3 text-left hover:bg-sidebar-accent"
        style={{ paddingLeft: `${0.75 + depth * INDENT_REM}rem` }}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        <Chevron
          className="size-3 shrink-0 self-center text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
          {node.name}/
        </span>
        {/* The roll-up is what makes a SHUT directory still worth reading: it
            says how much is under it without opening it. Same width as a file
            row's status, which is the column it shares. */}
        <span className="w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {node.files} {node.files === 1 ? 'file' : 'files'}
        </span>
        <LineCounts added={node.added} removed={node.removed} />
      </button>
      {open ? <TreeRows nodes={node.children} depth={depth + 1} /> : null}
    </li>
  );
}

function TreeRows({
  nodes,
  depth,
}: {
  nodes: readonly ChangeTreeNode[];
  depth: number;
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {nodes.map((node) =>
        node.type === 'dir' ? (
          <DirRow key={`dir:${node.path}`} node={node} depth={depth} />
        ) : (
          // Keyed on the pair: one path can appear twice — a file removed from
          // tracking is a `D` row from the diff AND an untracked row from
          // `ls-files`, which is a duplicate key and two rows whose expand state
          // can swap.
          <FileRow
            key={`${node.change.status}:${node.change.path}`}
            change={node.change}
            name={node.name}
            depth={depth}
          />
        ),
      )}
    </ul>
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
  startSha,
  changes,
  truncated,
  unavailableReason: reason,
  movedOffStart = false,
  error,
  loading,
  onRefresh,
  onClose,
}: {
  open: boolean;
  /** The commit the chat started at; null when nothing was stamped. */
  startSha: string | null;
  /**
   * The read, which this dialog no longer performs.
   *
   * It owned the read while it was the only thing that wanted one. The header's
   * changes chip states the SAME figures without anything being opened, so the
   * read moved up to `useChatChanges` and both draw from it — two readers would
   * mean two `git diff` runs whose answers could differ by whatever the agent
   * wrote in between, and the chip and the dialog disagreeing about one folder
   * at one instant is exactly the bug that would produce.
   */
  changes: GitChange[];
  truncated: boolean;
  unavailableReason: string | null;
  /**
   * The checkout moved off `startSha`, so the list is what is uncommitted NOW —
   * said in the header, since "against <sha>" would then be untrue.
   */
  movedOffStart?: boolean;
  error: string | null;
  loading: boolean;
  /** Asked for on open — the "I am looking at it now" read. */
  onRefresh: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    if (open) {
      onRefresh();
    }
    // `onRefresh` is in the deps and belongs there: it is a `useCallback` keyed
    // on the run's folder and starting commit, so within one open thread its
    // identity is stable and this fires once — and if the thread DID change
    // underneath an open dialog, re-reading is the correct answer rather than a
    // dependency to suppress.
  }, [open, onRefresh]);

  // Memoized because every DirRow and FileRow below owns expand state: rebuilding
  // the tree on an unrelated render would hand them new nodes and reset it.
  const tree = useMemo(() => buildChangesTree(changes), [changes]);

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
            : movedOffStart
              ? `This checkout has moved off ${startSha.slice(0, 12)}, the commit this chat started at, onto another branch — so this lists what is uncommitted on it now, including files that were created and never added. Read-only: undo anything here in your own git.`
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
          <TreeRows nodes={tree} depth={0} />
        </SearchResultList>
      </div>
    </Dialog>
  );
}
