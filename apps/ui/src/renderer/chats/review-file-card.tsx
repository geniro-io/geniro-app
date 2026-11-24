import { ChevronDown, ChevronRight, MessageSquarePlus } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';

import type {
  FileLines,
  GitChange,
  GitChangeStatus,
  ReadFileLinesRequest,
} from '../../shared/contracts';
import { CopyButton } from '../components/copy-button';
import { DiffFigures } from '../components/diff-figures';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { languageForPath } from '../components/ui/code-language';
import { highlightLines } from '../components/ui/highlight-lines';
import { cn } from '../components/ui/utils';
import { DIFF_ROW_LIMIT } from './diff-view';
import {
  anchorComment,
  type DiffHunk,
  type DiffRow,
  pairedWordSpans,
  parseFileDiff,
  type WordSpan,
} from './review-diff-model';
import {
  ReviewCommentEditor,
  ReviewCommentThread,
  reviewLineLabel,
} from './review-comment-thread';
import type {
  ReviewComment,
  ReviewCommentInput,
  ReviewController,
} from './use-review-comments';

export const STATUS_META: Record<
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

const EXPAND_STEP = 20;

const ROW_GRID =
  'grid grid-cols-[3.25rem_3.25rem_1.25rem_minmax(0,1fr)] items-start font-mono text-xs leading-5';

const ROW_TINT: Record<DiffRow['kind'], string> = {
  context: '',
  added: 'bg-success/10',
  removed: 'bg-destructive/10',
  note: 'text-muted-foreground',
};

const SIGN: Record<DiffRow['kind'], string> = {
  context: ' ',
  added: '+',
  removed: '−',
  note: ' ',
};

type Side = 'new' | 'old';

type Target =
  | { kind: 'file' }
  | { kind: 'lines'; side: Side; start: number; end: number };

interface PlacedRow {
  key: string;
  kind: DiffRow['kind'];
  oldLine: number | null;
  newLine: number | null;
  code: ReactNode;
}

function lineKey(side: Side, line: number): string {
  return `${side}:${line}`;
}

function withMarks(text: string, spans: readonly WordSpan[], tone: string): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [index, span] of spans.entries()) {
    if (span.start > at) {
      parts.push(text.slice(at, span.start));
    }
    parts.push(
      <span key={index} className={cn('rounded-sm', tone)}>
        {text.slice(span.start, span.end)}
      </span>,
    );
    at = span.end;
  }
  parts.push(text.slice(at));
  return parts;
}

function highlightedHunk(hunk: DiffHunk, language: string | null): ReactNode[] {
  const spans = pairedWordSpans(hunk);
  const newSide = hunk.rows.flatMap((row, index) =>
    row.kind === 'context' || row.kind === 'added' ? [index] : [],
  );
  const oldSide = hunk.rows.flatMap((row, index) =>
    row.kind === 'removed' ? [index] : [],
  );
  const code: ReactNode[] = hunk.rows.map((row) => row.text);
  for (const indexes of [newSide, oldSide]) {
    const lit = highlightLines(
      indexes.map((index) => hunk.rows[index]!.text),
      language,
    );
    indexes.forEach((index, at) => {
      code[index] = lit[at];
    });
  }
  for (const [index, marks] of spans) {
    const row = hunk.rows[index]!;
    if (marks.length > 0) {
      code[index] = withMarks(
        row.text,
        marks,
        row.kind === 'removed' ? 'bg-destructive/25' : 'bg-success/25',
      );
    }
  }
  return code;
}

function newEnd(hunk: DiffHunk): number {
  return hunk.newStart + Math.max(hunk.newLines, 1) - 1;
}

/**
 * One changed file as a card: its header with Viewed and a whole-file comment,
 * and its unified diff with line numbers, highlighting, the comments made on it
 * and the arrows that read more of the file around each hunk.
 */
export function ReviewFileCard({
  folder,
  change,
  comments,
  review,
  readFileLines,
  open,
  onToggleOpen,
  viewed,
  changedSinceViewed,
  onViewedChange,
}: {
  folder: string;
  change: GitChange;
  comments: readonly ReviewComment[];
  review: ReviewController;
  readFileLines?: (request: ReadFileLinesRequest) => Promise<FileLines>;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  viewed: boolean;
  changedSinceViewed: boolean;
  onViewedChange: (viewed: boolean) => void;
}): React.JSX.Element {
  const meta = STATUS_META[change.status];
  const [target, setTarget] = useState<Target | null>(null);
  const [anchor, setAnchor] = useState<{ side: Side; line: number } | null>(
    null,
  );
  const openCount = comments.filter(
    (comment) => comment.status !== 'resolved',
  ).length;
  const Chevron = open ? ChevronDown : ChevronRight;

  const add = async (input: Omit<ReviewCommentInput, 'folder' | 'path'>) => {
    await review.add({ folder, path: change.path, ...input });
  };

  return (
    <section
      data-slot="review-file-card"
      data-path={change.path}
      className="rounded-lg border border-border bg-card">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b border-border bg-card px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Fold ${change.path}` : `Unfold ${change.path}`}
          className="cursor-pointer text-muted-foreground"
          onClick={() => onToggleOpen(!open)}>
          <Chevron className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 font-mono text-xs break-all text-foreground">
          {change.oldPath === null ? null : (
            <span className="text-muted-foreground">{change.oldPath} → </span>
          )}
          {change.path}
        </span>
        <CopyButton text={change.path} label="Copy path" className="size-6" />
        <span className={cn('text-xs', meta.className)}>{meta.label}</span>
        <DiffFigures added={change.added} removed={change.removed} />
        {openCount > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {openCount} {openCount === 1 ? 'comment' : 'comments'}
          </span>
        ) : null}
        {changedSinceViewed ? (
          <span className="text-xs text-warning">Changed since you viewed it</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={`Comment on ${change.path}`}
            title="Comment on the whole file"
            onClick={() => {
              onToggleOpen(true);
              setTarget({ kind: 'file' });
            }}>
            <MessageSquarePlus className="size-4" aria-hidden />
          </Button>
          <Checkbox
            checked={viewed}
            onCheckedChange={onViewedChange}
            label="Viewed"
            aria-label={`Viewed ${change.path}`}
          />
        </span>
      </header>
      {open ? (
        <FileBody
          folder={folder}
          change={change}
          comments={comments}
          review={review}
          readFileLines={readFileLines}
          target={target}
          setTarget={setTarget}
          anchor={anchor}
          setAnchor={setAnchor}
          add={add}
        />
      ) : null}
    </section>
  );
}

function FileBody({
  folder,
  change,
  comments,
  review,
  readFileLines,
  target,
  setTarget,
  anchor,
  setAnchor,
  add,
}: {
  folder: string;
  change: GitChange;
  comments: readonly ReviewComment[];
  review: ReviewController;
  readFileLines?: (request: ReadFileLinesRequest) => Promise<FileLines>;
  target: Target | null;
  setTarget: (target: Target | null) => void;
  anchor: { side: Side; line: number } | null;
  setAnchor: (anchor: { side: Side; line: number } | null) => void;
  add: (input: Omit<ReviewCommentInput, 'folder' | 'path'>) => Promise<void>;
}): React.JSX.Element {
  const parsed = useMemo(() => parseFileDiff(change.diff), [change.diff]);
  const language = languageForPath(change.path);
  const lit = useMemo(
    () => parsed.hunks.map((hunk) => highlightedHunk(hunk, language)),
    [parsed, language],
  );
  const [showAll, setShowAll] = useState(false);
  const [revealedAbove, setRevealedAbove] = useState<ReadonlyMap<number, number>>(
    new Map(),
  );
  const [revealedBelow, setRevealedBelow] = useState(0);
  const [extra, setExtra] = useState<ReadonlyMap<number, string>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const expandable =
    readFileLines !== undefined &&
    parsed.hunks.length > 0 &&
    (change.status === 'modified' ||
      change.status === 'renamed' ||
      change.status === 'copied');

  const reveal = async (
    from: number,
    to: number,
    apply: (count: number) => void,
  ): Promise<void> => {
    if (readFileLines === undefined || to < from) {
      return;
    }
    const read = await readFileLines({
      dir: folder,
      path: change.path,
      at: 'worktree',
      from,
      to,
    });
    if (read.unavailableReason !== null) {
      setReadError(read.unavailableReason);
      return;
    }
    setReadError(null);
    setTotal(read.total);
    setExtra((current) => {
      const next = new Map(current);
      read.lines.forEach((line, index) => next.set(from + index, line));
      return next;
    });
    apply(read.lines.length);
  };

  const lineText = useMemo(() => {
    const sides = { new: new Map<number, string>(), old: new Map<number, string>() };
    for (const hunk of parsed.hunks) {
      for (const row of hunk.rows) {
        if (row.newLine !== null && row.kind !== 'removed') {
          sides.new.set(row.newLine, row.text);
        }
        if (row.oldLine !== null && row.kind !== 'added') {
          sides.old.set(row.oldLine, row.text);
        }
      }
    }
    for (const [line, text] of extra) {
      if (!sides.new.has(line)) {
        sides.new.set(line, text);
      }
    }
    return sides;
  }, [parsed, extra]);

  const quoteOf = (side: Side, start: number, end: number): string => {
    const lines: string[] = [];
    for (let line = start; line <= end; line += 1) {
      const text = lineText[side].get(line);
      if (text !== undefined) {
        lines.push(text);
      }
    }
    return lines.join('\n');
  };

  const pick = (side: Side, line: number, extend: boolean): void => {
    if (extend && anchor !== null && anchor.side === side) {
      setTarget({
        kind: 'lines',
        side,
        start: Math.min(anchor.line, line),
        end: Math.max(anchor.line, line),
      });
      return;
    }
    setAnchor({ side, line });
    setTarget({ kind: 'lines', side, start: line, end: line });
  };

  const rows: { hunkIndex: number; band: boolean; row: PlacedRow }[] = [];
  let budget = showAll ? Number.POSITIVE_INFINITY : DIFF_ROW_LIMIT;
  let hidden = 0;
  parsed.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      hunkIndex,
      band: true,
      row: { key: `band:${hunkIndex}`, kind: 'note', oldLine: null, newLine: null, code: null },
    });
    const above = revealedAbove.get(hunkIndex) ?? 0;
    const offset = hunk.oldStart - hunk.newStart;
    for (let line = hunk.newStart - above; line < hunk.newStart; line += 1) {
      const text = extra.get(line);
      if (text !== undefined) {
        rows.push({
          hunkIndex,
          band: false,
          row: { key: `x:${line}`, kind: 'context', oldLine: line + offset, newLine: line, code: text },
        });
      }
    }
    hunk.rows.forEach((row, index) => {
      if (budget <= 0) {
        hidden += 1;
        return;
      }
      budget -= 1;
      rows.push({
        hunkIndex,
        band: false,
        row: {
          key: `r:${hunkIndex}:${index}`,
          kind: row.kind,
          oldLine: row.kind === 'added' ? null : row.oldLine,
          newLine: row.kind === 'removed' ? null : row.newLine,
          code: lit[hunkIndex]![index],
        },
      });
    });
  });
  const last = parsed.hunks[parsed.hunks.length - 1];
  if (last !== undefined && hidden === 0) {
    const lastNew = newEnd(last);
    const offset = last.oldStart + last.oldLines - 1 - lastNew;
    for (let line = lastNew + 1; line <= lastNew + revealedBelow; line += 1) {
      const text = extra.get(line);
      if (text !== undefined) {
        rows.push({
          hunkIndex: parsed.hunks.length,
          band: false,
          row: { key: `x:${line}`, kind: 'context', oldLine: line + offset, newLine: line, code: text },
        });
      }
    }
  }
  const revealedText = rows.filter((entry) => entry.row.key.startsWith('x:'));
  const revealedLit = highlightLines(
    revealedText.map((entry) => String(entry.row.code)),
    language,
  );
  revealedText.forEach((entry, index) => {
    entry.row.code = revealedLit[index];
  });

  const shown = new Set<string>();
  for (const { row } of rows) {
    if (row.newLine !== null) {
      shown.add(lineKey('new', row.newLine));
    }
    if (row.kind === 'removed' && row.oldLine !== null) {
      shown.add(lineKey('old', row.oldLine));
    }
  }
  const placed = new Map<string, { comment: ReviewComment; outdated: boolean }[]>();
  const loose: { comment: ReviewComment; outdated: boolean }[] = [];
  for (const comment of comments) {
    const where = anchorComment(comment, parsed.hunks);
    if (where.kind === 'line' && shown.has(lineKey(where.side, where.endLine))) {
      const key = lineKey(where.side, where.endLine);
      placed.set(key, [...(placed.get(key) ?? []), { comment, outdated: false }]);
    } else {
      loose.push({ comment, outdated: where.kind === 'outdated' });
    }
  }

  const thread = ({ comment, outdated }: { comment: ReviewComment; outdated: boolean }) => (
    <ReviewCommentThread
      key={comment.id}
      comment={comment}
      outdated={outdated}
      onEdit={(body) => review.edit(comment.id, body)}
      onDelete={() => review.remove(comment.id)}
      onStatus={(status) => review.setStatus(comment.id, status)}
    />
  );

  const editorFor = (side: Side, line: number): ReactNode => {
    if (target?.kind !== 'lines' || target.side !== side || target.end !== line) {
      return null;
    }
    const { start, end } = target;
    return (
      <ReviewCommentEditor
        key={`editor:${side}:${start}:${end}`}
        heading={reviewLineLabel(side, start, end)}
        onSubmit={(body) =>
          add({ side, startLine: start, endLine: end, quote: quoteOf(side, start, end), body })
        }
        onCancel={() => {
          setTarget(null);
          setAnchor(null);
        }}
      />
    );
  };

  const numberCell = (side: Side, line: number | null, commentable: boolean): ReactNode => {
    if (line === null) {
      return <span />;
    }
    if (!commentable) {
      return <span className="pr-2 text-right text-muted-foreground select-none">{line}</span>;
    }
    const picked =
      target?.kind === 'lines' && target.side === side && line >= target.start && line <= target.end;
    return (
      <button
        type="button"
        aria-label={`Comment on ${side} line ${line}`}
        title="Comment on this line — Shift-click another to cover a range"
        className={cn(
          'cursor-pointer pr-2 text-right text-muted-foreground select-none hover:text-primary focus-visible:text-primary focus-visible:outline-none',
          picked && 'bg-primary/15 text-primary',
        )}
        onClick={(event) => pick(side, line, event.shiftKey)}>
        {line}
      </button>
    );
  };

  const bandButton = (hunkIndex: number): ReactNode => {
    const hunk = parsed.hunks[hunkIndex]!;
    if (!expandable) {
      return null;
    }
    const previous = parsed.hunks[hunkIndex - 1];
    const floor = previous === undefined ? 0 : newEnd(previous);
    const above = revealedAbove.get(hunkIndex) ?? 0;
    const remaining = hunk.newStart - 1 - floor - above;
    if (remaining <= 0) {
      return null;
    }
    const count = Math.min(EXPAND_STEP, remaining);
    const to = hunk.newStart - above - 1;
    return (
      <button
        type="button"
        className="cursor-pointer rounded px-1.5 text-primary hover:bg-primary/10"
        onClick={() =>
          void reveal(to - count + 1, to, (got) =>
            setRevealedAbove((current) =>
              new Map(current).set(hunkIndex, above + got),
            ),
          )
        }>
        {`Show ${count} more lines above`}
      </button>
    );
  };

  const belowButton = (): ReactNode => {
    if (!expandable || last === undefined || hidden > 0) {
      return null;
    }
    const from = newEnd(last) + 1 + revealedBelow;
    if (total !== null && from > total) {
      return null;
    }
    const count = total === null ? EXPAND_STEP : Math.min(EXPAND_STEP, total - from + 1);
    return (
      <div className="border-t border-border px-3 py-1 font-mono text-xs">
        <button
          type="button"
          className="cursor-pointer rounded px-1.5 text-primary hover:bg-primary/10"
          onClick={() =>
            void reveal(from, from + count - 1, (got) => {
              setRevealedBelow((current) => current + got);
              if (got < count) {
                setTotal(from + got - 1);
              }
            })
          }>
          {`Show ${count} more lines below`}
        </button>
      </div>
    );
  };

  const fileComments = loose.filter((entry) => entry.comment.side === 'file');
  const otherLoose = loose.filter((entry) => entry.comment.side !== 'file');
  const message = bodyMessage(change, parsed);

  return (
    <div data-slot="review-diff" className="flex flex-col">
      {parsed.notes.length > 0 ? (
        <ul className="m-0 list-none border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {parsed.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {fileComments.length > 0 || otherLoose.length > 0 || target?.kind === 'file' ? (
        <div className="flex flex-col gap-2 border-b border-border p-3">
          {[...fileComments, ...otherLoose].map(thread)}
          {target?.kind === 'file' ? (
            <ReviewCommentEditor
              heading="Whole file"
              onSubmit={(body) =>
                add({ side: 'file', startLine: null, endLine: null, quote: '', body })
              }
              onCancel={() => setTarget(null)}
            />
          ) : null}
        </div>
      ) : null}
      {message === null ? null : (
        <p className="px-3 py-3 text-sm text-muted-foreground">{message}</p>
      )}
      {parsed.hunks.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="min-w-max">
            {rows.map(({ hunkIndex, band, row }) => {
              if (band) {
                const hunk = parsed.hunks[hunkIndex]!;
                return (
                  <div
                    key={row.key}
                    className="flex items-center gap-3 border-y border-border/60 bg-muted/50 px-3 py-0.5 font-mono text-xs text-muted-foreground">
                    <span>
                      {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}{' '}
                      {hunk.context.trim()}
                    </span>
                    {bandButton(hunkIndex)}
                  </div>
                );
              }
              const newSide = row.kind !== 'removed' && row.kind !== 'note';
              const after: ReactNode[] = [];
              if (row.newLine !== null && newSide) {
                after.push(
                  ...(placed.get(lineKey('new', row.newLine)) ?? []).map(thread),
                  editorFor('new', row.newLine),
                );
              }
              if (row.kind === 'removed' && row.oldLine !== null) {
                after.push(
                  ...(placed.get(lineKey('old', row.oldLine)) ?? []).map(thread),
                  editorFor('old', row.oldLine),
                );
              }
              const extras = after.filter((node) => node !== null);
              return (
                <Fragment key={row.key}>
                  <div className={cn(ROW_GRID, ROW_TINT[row.kind])}>
                    {numberCell('old', row.oldLine, row.kind === 'removed')}
                    {numberCell('new', row.newLine, newSide)}
                    <span
                      className={cn(
                        'select-none',
                        row.kind === 'added' && 'text-success',
                        row.kind === 'removed' && 'text-destructive',
                      )}>
                      {SIGN[row.kind]}
                    </span>
                    <span className="pr-4 whitespace-pre">{row.code}</span>
                  </div>
                  {extras.length > 0 ? (
                    <div className="flex flex-col gap-2 border-y border-border/60 bg-background px-3 py-2 sm:pl-[7.75rem]">
                      {extras}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
      {hidden > 0 ? (
        <div className="border-t border-border px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            {`Show all ${hidden + DIFF_ROW_LIMIT} lines`}
          </Button>
        </div>
      ) : null}
      {belowButton()}
      {readError === null ? null : (
        <p className="px-3 py-2 text-xs text-destructive">{readError}</p>
      )}
      {parsed.truncatedLines === null ? null : (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {`${parsed.truncatedLines} more lines are not shown — open the file to read the rest.`}
        </p>
      )}
    </div>
  );
}

function bodyMessage(
  change: GitChange,
  parsed: ReturnType<typeof parseFileDiff>,
): string | null {
  if (change.diff === null) {
    return change.status === 'untracked'
      ? 'Its contents are not shown — only the first new files of a change are read.'
      : 'No diff for this file — it is either too large for one read or git could not produce one.';
  }
  if (parsed.binary) {
    return 'Binary file — there are no lines to show.';
  }
  if (parsed.hunks.length === 0 && parsed.truncatedLines === null) {
    return parsed.notes.length > 0 ? null : 'No line changes in this file.';
  }
  return null;
}
