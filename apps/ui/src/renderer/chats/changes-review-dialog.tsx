import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  FileLines,
  GitChange,
  GitChanges,
  ReadFileLinesRequest,
} from '../../shared/contracts';
import { DiffFigures } from '../components/diff-figures';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { ExpandableTextarea } from '../components/expandable-textarea';
import { SearchResultList } from '../components/search-panel';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';
import { useNarrowViewport } from '../components/use-narrow-viewport';
import { buildChangesTree, type ChangeTreeNode } from './changes-tree';
import { folderName } from './directory-select';
import { ReviewCommentThread, reviewLineLabel } from './review-comment-thread';
import { ReviewFileCard, STATUS_META } from './review-file-card';
import { useThreadFlags } from './thread-ui-memory';
import type { WorkFolderChanges } from './use-chat-changes';
import type { ReviewComment, ReviewController } from './use-review-comments';

const NO_WORK_FOLDERS: readonly WorkFolderChanges[] = [];

/** Diff lines the cards open with, before the rest start folded behind their headers. */
const OPEN_ROW_BUDGET = 2_000;

interface ReviewFile {
  key: string;
  folder: string;
  change: GitChange;
  bodyKey: string;
  anyKey: string;
}

interface FolderSection {
  folder: string;
  primary: boolean;
  upstreamBase: GitChanges['upstreamBase'];
  files: ReviewFile[];
}

/** FNV-1a over the diff body: cheap, and it needs no secure context, which a phone's page lacks. */
function bodyHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function reviewFile(folder: string, change: GitChange): ReviewFile {
  const id = `${folder}\0${change.path}`;
  return {
    key: `${id}\0${change.status}`,
    folder,
    change,
    bodyKey: `review-viewed:${id}\0${bodyHash(change.diff ?? '')}`,
    anyKey: `review-viewed-any:${id}`,
  };
}

function baseLine({
  startSha,
  movedOffStart,
  upstreamBase,
}: {
  startSha: string | null;
  movedOffStart: boolean;
  upstreamBase: GitChanges['upstreamBase'];
}): string {
  if (startSha === null) {
    return 'This chat was not stamped with a commit, so there is nothing to compare against.';
  }
  if (movedOffStart) {
    return `This checkout has moved off ${startSha.slice(0, 12)}, the commit this chat started at, onto another branch — so this shows what is uncommitted on it now, including files that were created and never added. Comments stay in Geniro; undo anything here in your own git.`;
  }
  if (upstreamBase !== null) {
    return `Working tree against ${upstreamBase.sha.slice(0, 12)}, the newest commit this checkout shares with ${upstreamBase.ref} — everything up to it is already there, so it is left out. This chat started at ${startSha.slice(0, 12)}. Comments stay in Geniro; undo anything here in your own git.`;
  }
  return `Working tree against ${startSha.slice(0, 12)} — including files that were created and never added. Comments stay in Geniro and go to the agent only when you send the review.`;
}

/**
 * The thread's changes as a review: every changed file as a line-numbered,
 * highlighted unified diff, with Viewed marks kept on this device and comments
 * on lines, ranges and whole files that go to the thread's agent as one review.
 * Read-only toward the tree: nothing here stages, reverts or touches git.
 */
export function ChangesReviewDialog({
  open,
  folder,
  startSha,
  changes,
  elsewhere = NO_WORK_FOLDERS,
  truncated,
  unavailableReason: reason,
  movedOffStart = false,
  upstreamBase = null,
  error,
  loading,
  review,
  readFileLines,
  focusComment = null,
  onRefresh,
  onClose,
}: {
  open: boolean;
  /** The thread's own folder, where its line and file comments are made. */
  folder: string;
  startSha: string | null;
  baseSha: string | null;
  threadId: string;
  changes: GitChange[];
  elsewhere?: readonly WorkFolderChanges[];
  truncated: boolean;
  unavailableReason: string | null;
  movedOffStart?: boolean;
  upstreamBase?: GitChanges['upstreamBase'];
  error: string | null;
  loading: boolean;
  review: ReviewController;
  /** Absent on a paired device, which gets no "show more lines" arrows. */
  readFileLines?: (request: ReadFileLinesRequest) => Promise<FileLines>;
  /** A comment to bring into view as the screen opens. */
  focusComment?: number | null;
  onRefresh: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    if (open) {
      onRefresh();
    }
  }, [open, onRefresh]);

  const narrow = useNarrowViewport();
  const flags = useThreadFlags();
  const [filter, setFilter] = useState('');
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);

  const sections = useMemo<FolderSection[]>(
    () => [
      {
        folder,
        primary: true,
        upstreamBase,
        files: changes.map((change) => reviewFile(folder, change)),
      },
      ...elsewhere.map((held) => ({
        folder: held.folder,
        primary: false,
        upstreamBase: held.upstreamBase,
        files: held.changes.map((change) => reviewFile(held.folder, change)),
      })),
    ],
    [folder, changes, elsewhere, upstreamBase],
  );
  const files = useMemo(
    () => sections.flatMap((section) => section.files),
    [sections],
  );

  const viewedOf = (file: ReviewFile): boolean =>
    flags.get(file.bodyKey) === true;
  const setViewed = (file: ReviewFile, viewed: boolean): void => {
    flags.set(file.bodyKey, viewed);
    flags.set(file.anyKey, viewed);
    setFolds((was) => {
      const next = new Map(was);
      next.delete(file.key);
      return next;
    });
  };
  const viewedCount = files.filter(viewedOf).length;

  const startsOpen = useMemo(() => {
    const opened = new Set<string>();
    let rows = 0;
    for (const file of files) {
      if (rows <= OPEN_ROW_BUDGET) {
        opened.add(file.key);
      }
      rows += file.change.diff?.split('\n').length ?? 0;
    }
    return opened;
  }, [files]);

  const commentsByFile = useMemo(() => {
    const byFile = new Map<string, ReviewComment[]>();
    for (const comment of review.comments) {
      const id = `${comment.folder}\0${comment.path}`;
      byFile.set(id, [...(byFile.get(id) ?? []), comment]);
    }
    return byFile;
  }, [review.comments]);
  const listed = new Set(
    files.map((file) => `${file.folder}\0${file.change.path}`),
  );
  const gone = review.comments.filter(
    (comment) => !listed.has(`${comment.folder}\0${comment.path}`),
  );
  const drafts = review.comments.filter(
    (comment) => comment.status === 'draft',
  );
  const openComments = review.comments.filter(
    (comment) => comment.status === 'sent',
  ).length;
  const resolved = review.comments.filter(
    (comment) => comment.status === 'resolved',
  ).length;

  useEffect(() => {
    if (!open || focusComment === null) {
      return;
    }
    scroller.current
      ?.querySelector(`[data-comment-number="${focusComment}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [open, focusComment, review.comments]);

  const selected =
    files.find((file) => file.key === current) ?? files[0] ?? null;
  const selectedIndex = selected === null ? -1 : files.indexOf(selected);

  const card = (file: ReviewFile): React.JSX.Element => {
    const viewed = viewedOf(file);
    return (
      <ReviewFileCard
        key={file.key}
        folder={file.folder}
        place={file.folder === folder ? null : folderName(file.folder)}
        change={file.change}
        comments={
          commentsByFile.get(`${file.folder}\0${file.change.path}`) ?? []
        }
        review={review}
        readFileLines={readFileLines}
        open={
          folds.get(file.key) ??
          (!viewed && (narrow || startsOpen.has(file.key)))
        }
        onToggleOpen={(next) =>
          setFolds((was) => new Map(was).set(file.key, next))
        }
        viewed={viewed}
        changedSinceViewed={!viewed && flags.get(file.anyKey) === true}
        onViewedChange={(next) => setViewed(file, next)}
      />
    );
  };

  const jumpTo = (file: ReviewFile): void => {
    setCurrent(file.key);
    if (!narrow) {
      scroller.current
        ?.querySelector(`[data-review-key="${CSS.escape(file.key)}"]`)
        ?.scrollIntoView({ block: 'start' });
    }
  };

  const needle = filter.trim().toLowerCase();
  const title = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>Review changes</span>
      <span className="text-xs font-normal text-muted-foreground tabular-nums">
        {viewedCount} of {files.length} viewed
      </span>
      {openComments + resolved > 0 ? (
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {openComments} open · {resolved} resolved
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Refresh"
          title="Read the folder again"
          onClick={onRefresh}>
          <RefreshCw className="size-4" aria-hidden />
        </Button>
        {review.sending === 'waiting' ? (
          <>
            <span className="text-xs font-normal text-muted-foreground">
              Waiting for the turn to end
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={review.cancelWaiting}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={drafts.length === 0 || review.sending === 'sending'}
            onClick={() => setSendOpen(true)}>
            {`Send review · ${drafts.length}`}
          </Button>
        )}
      </span>
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} fullScreen title={title}>
      <div className="flex h-full min-h-0 flex-col">
        <p className="shrink-0 border-b border-border px-5 py-2 text-xs text-muted-foreground">
          {baseLine({ startSha, movedOffStart, upstreamBase })}
        </p>
        {error ? (
          <ErrorText className="shrink-0 px-5 py-2">{error}</ErrorText>
        ) : null}
        {review.error ? (
          <ErrorText className="shrink-0 px-5 py-2">{review.error}</ErrorText>
        ) : null}
        {focusComment !== null &&
        !review.comments.some((comment) => comment.number === focusComment) ? (
          <p className="shrink-0 px-5 py-2 text-xs text-muted-foreground">
            {`Comment #${focusComment} was deleted.`}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1">
          {narrow ? null : (
            <nav
              aria-label="Changed files"
              className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-3">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files"
                aria-label="Filter files"
              />
              {sections.map((section) => (
                <div key={section.folder} className="flex flex-col">
                  {section.primary ? null : (
                    <p
                      className="px-1 pt-2 pb-1 text-xs text-muted-foreground"
                      title={section.folder}>
                      In{' '}
                      <span className="font-mono text-foreground">
                        {folderName(section.folder)}
                      </span>{' '}
                      — a worktree this chat’s agents worked in
                      {section.upstreamBase === null ? null : (
                        <>
                          , against{' '}
                          <span className="font-mono text-foreground">
                            {section.upstreamBase.ref}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                  <FileTree
                    nodes={buildChangesTree(
                      section.files
                        .filter(
                          (file) =>
                            needle === '' ||
                            file.change.path.toLowerCase().includes(needle),
                        )
                        .map((file) => file.change),
                    )}
                    depth={0}
                    fileOf={(change) =>
                      section.files.find((file) => file.change === change) ??
                      null
                    }
                    openCount={(file) =>
                      (
                        commentsByFile.get(
                          `${file.folder}\0${file.change.path}`,
                        ) ?? []
                      ).filter((comment) => comment.status !== 'resolved')
                        .length
                    }
                    viewed={viewedOf}
                    onPick={jumpTo}
                  />
                </div>
              ))}
            </nav>
          )}
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            {narrow && files.length > 0 && selected !== null ? (
              <div className="mb-3 flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Previous file"
                  disabled={selectedIndex <= 0}
                  onClick={() => setCurrent(files[selectedIndex - 1]!.key)}>
                  <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <Select
                  aria-label="File"
                  groups={[
                    {
                      items: files.map((file) => ({
                        value: file.key,
                        label: file.change.path,
                      })),
                    },
                  ]}
                  value={selected.key}
                  onValueChange={setCurrent}
                  flexible
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Next file"
                  disabled={selectedIndex >= files.length - 1}
                  onClick={() => setCurrent(files[selectedIndex + 1]!.key)}>
                  <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            ) : null}
            <SearchResultList
              loading={loading}
              loadingLabel="Reading the folder…"
              unavailableReason={elsewhere.length > 0 ? null : reason}
              partialReason={
                truncated
                  ? 'More files changed than this view lists — showing the first of them by path.'
                  : null
              }
              isEmpty={files.length === 0 && gone.length === 0}
              empty={
                <EmptyState>
                  Nothing has changed in this folder since the chat started.
                </EmptyState>
              }>
              <div className="flex flex-col gap-3">
                {reason && elsewhere.length > 0 ? (
                  <EmptyState>{reason}</EmptyState>
                ) : null}
                {(narrow ? (selected === null ? [] : [selected]) : files).map(
                  (file) => (
                    <div key={file.key} data-review-key={file.key}>
                      {card(file)}
                    </div>
                  ),
                )}
                {gone.length > 0 ? (
                  <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <h3 className="text-sm font-medium">No longer changed</h3>
                    {gone.map((comment) => (
                      <div key={comment.id} className="flex flex-col gap-1">
                        <p className="font-mono text-xs text-muted-foreground">
                          {comment.path}
                        </p>
                        <ReviewCommentThread
                          comment={comment}
                          outdated
                          onEdit={(body) => review.edit(comment.id, body)}
                          onDelete={() => review.remove(comment.id)}
                          onStatus={(status) =>
                            review.setStatus(comment.id, status)
                          }
                        />
                      </div>
                    ))}
                  </section>
                ) : null}
              </div>
            </SearchResultList>
          </div>
        </div>
      </div>
      <SendReviewDialog
        open={sendOpen}
        drafts={drafts}
        onClose={() => setSendOpen(false)}
        onSend={async (note) => {
          setSendOpen(false);
          await review.send(note);
        }}
      />
    </Dialog>
  );
}

function FileTree({
  nodes,
  depth,
  fileOf,
  openCount,
  viewed,
  onPick,
}: {
  nodes: readonly ChangeTreeNode[];
  depth: number;
  fileOf: (change: GitChange) => ReviewFile | null;
  openCount: (file: ReviewFile) => number;
  viewed: (file: ReviewFile) => boolean;
  onPick: (file: ReviewFile) => void;
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {nodes.map((node) => {
        if (node.type === 'dir') {
          return (
            <li key={`dir:${node.path}`}>
              <p
                className="truncate py-0.5 font-mono text-xs text-muted-foreground"
                style={{ paddingLeft: `${0.375 + depth * 0.75}rem` }}
                title={node.path}>
                {node.name}/
              </p>
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                fileOf={fileOf}
                openCount={openCount}
                viewed={viewed}
                onPick={onPick}
              />
            </li>
          );
        }
        const file = fileOf(node.change);
        if (file === null) {
          return null;
        }
        const count = openCount(file);
        return (
          <li key={file.key}>
            <button
              type="button"
              title={file.change.path}
              style={{ paddingLeft: `${0.375 + depth * 0.75}rem` }}
              className={cn(
                'flex w-full cursor-pointer items-baseline gap-2 rounded py-1 pr-1.5 text-left hover:bg-sidebar-accent',
                viewed(file) && 'opacity-60',
              )}
              onClick={() => onPick(file)}>
              <span
                aria-hidden
                className={cn(
                  'text-[10px]',
                  STATUS_META[file.change.status].className,
                )}>
                ●
              </span>
              <span className="min-w-0 flex-1 font-mono text-xs break-all">
                {node.name}
              </span>
              {count > 0 ? (
                <span className="text-xs text-primary tabular-nums">
                  {count}
                </span>
              ) : null}
              <DiffFigures
                added={file.change.added}
                removed={file.change.removed}
                className="text-[11px]"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SendReviewDialog({
  open,
  drafts,
  onClose,
  onSend,
}: {
  open: boolean;
  drafts: readonly ReviewComment[];
  onClose: () => void;
  onSend: (note: string | null) => Promise<void>;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send the review to the agent"
      className="max-w-xl">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {drafts.length === 1
            ? 'One comment goes'
            : `${drafts.length} comments go`}{' '}
          to the agent as one message. If it is working, the review waits for
          its turn to end.
        </p>
        <ul className="m-0 flex max-h-72 list-none flex-col gap-2 overflow-y-auto p-0">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="rounded-md border border-border px-3 py-2 text-sm">
              <p className="font-mono text-xs text-muted-foreground">
                {`#${draft.number} · ${draft.path} · ${reviewLineLabel(draft.side, draft.startLine, draft.endLine)}`}
              </p>
              <p className="whitespace-pre-wrap">{draft.body}</p>
            </li>
          ))}
        </ul>
        <ExpandableTextarea
          ariaLabel="Review note"
          title="Note for the review"
          value={note}
          onChange={setNote}
          rows={2}
          placeholder="A note for the whole review (optional)"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              const text = note.trim();
              setNote('');
              void onSend(text === '' ? null : text);
            }}>
            Send review
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
