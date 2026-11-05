import { structuredPatch } from 'diff';
import { memo, useMemo, useState } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { formatCount } from '../stats/stats-format';
import { isProposedChange, SAVE_PROJECT_INSTRUCTIONS } from './geniro-tool';

/**
 * geniro's OWN patch-proposal tool.
 *
 * TWIN: `HOST_PATCH_TOOL` in `apps/daemon/src/v1/agents/chat.types.ts`. A bare
 * literal because nothing generated spans this seam — the name reaches the
 * renderer inside an `approval_request` payload, which is `z.unknown()` on the
 * wire by design. `transcript-groups.ts` keeps the same literal for the same
 * reason; renaming the tool means renaming it in all three.
 */
export const PROPOSE_PATCH = 'propose_patch';

/**
 * The project card's changed lines as unified-diff hunks and the `P-` ids it
 * carries out, or null for another tool or a card with no hunks.
 *
 * TWIN PARSER: `projectInstructionsCardInput` in the daemon's
 * `agents/utils/host-project-instructions.ts` writes the input this file
 * reads — `diff` and `ids` here, the whole `old_string` / `new_string` in
 * `editDiffOf`.
 */
export function projectInstructionsCardOf(
  toolName: string,
  input: unknown,
): { diff: string; ids: string[] } | null {
  if (toolName !== SAVE_PROJECT_INSTRUCTIONS || !input) {
    return null;
  }
  const { diff, ids } = input as { diff?: unknown; ids?: unknown };
  if (typeof diff !== 'string' || diff === '') {
    return null;
  }
  return {
    diff,
    ids: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

/**
 * Extract the old/new texts of a file-editing tool input, when this tool IS
 * one: an Edit carries `old_string`→`new_string`, a Write (file creation)
 * carries only `content`. Null for every other tool/shape — callers fall
 * back to their raw-JSON body. Shared by the tool-group rows and the
 * approval card, so both surfaces render the same diff for the same call.
 *
 * geniro's `propose_patch` rides the Edit arm rather than growing a renderer of
 * its own, and that is why the tool advertises `Edit`'s field names: a proposal
 * and an edit are the same diff, differing only in who writes the file and
 * when. Its `old_string` is optional, so it falls through to the Write shape —
 * additions only — when the patch creates or rewrites a whole file.
 */
export function editDiffOf(
  toolName: string,
  input: unknown,
): { oldText: string | null; newText: string } | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (toolName === 'Edit' || isProposedChange(toolName)) {
    const oldText = record.old_string;
    const newText = record.new_string;
    if (typeof newText === 'string') {
      // An absent `old_string` is only legal for a proposal, where it means a
      // whole-file write or a project with no instructions yet; an Edit
      // missing one is a malformed call and falls through to the raw-JSON
      // body, as it always has.
      if (typeof oldText === 'string') {
        return { oldText, newText };
      }
      if (isProposedChange(toolName)) {
        return { oldText: null, newText };
      }
    }
  }
  if (toolName === 'Write' && typeof record.content === 'string') {
    return { oldText: null, newText: record.content };
  }
  return null;
}

const REMOVED_CLASS = 'bg-destructive/10 text-destructive';
const ADDED_CLASS = 'bg-success/10 text-success';

/** Unchanged lines kept around each change, as `git diff` keeps them. */
const DIFF_CONTEXT_LINES = 3;

/** Rows drawn before Show all: an agent's edit can carry the whole file on both sides. */
export const DIFF_ROW_LIMIT = 400;

/**
 * How far the line diff may search before it gives up and the diff falls back
 * to trimming what the two sides share at either end — two unrelated files
 * would otherwise cost the main thread a quadratic search.
 */
const DIFF_MAX_EDIT_LENGTH = 1000;

type DiffRow =
  | { kind: 'removed' | 'added' | 'context'; text: string }
  | { kind: 'gap'; skipped: number };

function linesOf(text: string): string[] {
  return text.split('\n');
}

/**
 * The rows of a line diff: each change with up to {@link DIFF_CONTEXT_LINES}
 * unchanged lines around it, and every longer unchanged stretch as one gap. A
 * file creation (no old text) is its new text as additions.
 */
export function diffRows(
  oldText: string | null | undefined,
  newText: string,
): DiffRow[] {
  if (!oldText) {
    return linesOf(newText).map((text) => ({ kind: 'added', text }));
  }
  const oldLines = linesOf(oldText);
  // The trailing newline keeps jsdiff from reporting a missing end-of-file
  // newline as a change of the last line.
  const patch = structuredPatch(
    '',
    '',
    `${oldText}\n`,
    `${newText}\n`,
    undefined,
    undefined,
    { context: DIFF_CONTEXT_LINES, maxEditLength: DIFF_MAX_EDIT_LENGTH },
  );
  if (patch === undefined) {
    return trimmedRows(oldLines, linesOf(newText));
  }
  const rows: DiffRow[] = [];
  let consumed = 0;
  for (const hunk of patch.hunks) {
    const skipped = hunk.oldStart - 1 - consumed;
    if (skipped > 0) {
      rows.push({ kind: 'gap', skipped });
    }
    consumed = Math.max(consumed, hunk.oldStart - 1);
    for (const line of hunk.lines) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === '-') {
        rows.push({ kind: 'removed', text });
        consumed += 1;
      } else if (sign === '+') {
        rows.push({ kind: 'added', text });
      } else if (sign === ' ') {
        rows.push({ kind: 'context', text });
        consumed += 1;
      }
    }
  }
  if (oldLines.length > consumed) {
    rows.push({ kind: 'gap', skipped: oldLines.length - consumed });
  }
  return rows;
}

/** The diff when the line search gave up: only what lies between the shared ends. */
function trimmedRows(oldLines: string[], newLines: string[]): DiffRow[] {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] ===
      newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const before = Math.max(0, head - DIFF_CONTEXT_LINES);
  const after = Math.min(tail, DIFF_CONTEXT_LINES);
  const context = (lines: string[]): DiffRow[] =>
    lines.map((text) => ({ kind: 'context', text }));
  return [
    ...(before > 0 ? [{ kind: 'gap', skipped: before } as const] : []),
    ...context(oldLines.slice(before, head)),
    ...oldLines
      .slice(head, oldLines.length - tail)
      .map((text): DiffRow => ({ kind: 'removed', text })),
    ...newLines
      .slice(head, newLines.length - tail)
      .map((text): DiffRow => ({ kind: 'added', text })),
    ...context(
      oldLines.slice(oldLines.length - tail, oldLines.length - tail + after),
    ),
    ...(tail > after ? [{ kind: 'gap', skipped: tail - after } as const] : []),
  ];
}

/**
 * The first `limit` rows, a change cut by the limit keeping both sides: its
 * removed and its added lines share the room left, and a side shorter than
 * its half leaves the rest to the other.
 */
function cappedRows(rows: DiffRow[], limit: number): DiffRow[] {
  if (rows.length <= limit) {
    return rows;
  }
  const shown: DiffRow[] = [];
  let index = 0;
  while (index < rows.length && shown.length < limit) {
    if (rows[index]?.kind !== 'removed') {
      shown.push(rows[index]!);
      index += 1;
      continue;
    }
    let removedEnd = index;
    while (rows[removedEnd]?.kind === 'removed') {
      removedEnd += 1;
    }
    let addedEnd = removedEnd;
    while (rows[addedEnd]?.kind === 'added') {
      addedEnd += 1;
    }
    const room = limit - shown.length;
    const added = addedEnd - removedEnd;
    const removedShown = Math.min(
      removedEnd - index,
      Math.max(Math.floor(room / 2), room - added),
    );
    shown.push(
      ...rows.slice(index, index + removedShown),
      ...rows.slice(
        removedEnd,
        removedEnd + Math.min(added, room - removedShown),
      ),
    );
    index = addedEnd;
  }
  return shown;
}

const ROW_CLASS: Record<Exclude<DiffRow['kind'], 'gap'>, string> = {
  removed: REMOVED_CLASS,
  added: ADDED_CLASS,
  context: 'text-foreground',
};

const ROW_SIGN: Record<Exclude<DiffRow['kind'], 'gap'>, string> = {
  removed: '-',
  added: '+',
  context: ' ',
};

/**
 * GitHub-style line diff for file-editing tool calls: what changed as red `-`
 * and green `+` lines between unchanged context, long unchanged stretches
 * folded into one gap row, and at most {@link DIFF_ROW_LIMIT} rows until the
 * reader asks for all — a rewrite the limit cuts shows both its sides. A Write
 * (file creation) shows only added lines.
 */
export const DiffView = memo(function DiffView({
  oldText,
  newText,
}: {
  oldText?: string | null;
  newText: string;
}): React.JSX.Element {
  const rows = useMemo(() => diffRows(oldText, newText), [oldText, newText]);
  // Keyed to the texts it was pressed for, so new texts start capped again.
  const [expanded, setExpanded] = useState<{
    oldText: string | null | undefined;
    newText: string;
  } | null>(null);
  const showAll =
    expanded !== null &&
    expanded.oldText === oldText &&
    expanded.newText === newText;
  const shown = showAll ? rows : cappedRows(rows, DIFF_ROW_LIMIT);
  return (
    <div
      data-slot="diff"
      className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {shown.map((row, index) =>
        row.kind === 'gap' ? (
          <div
            key={index}
            data-slot="diff-gap"
            className="select-none px-2 text-muted-foreground">
            ⋯ {formatCount(row.skipped)} unchanged{' '}
            {row.skipped === 1 ? 'line' : 'lines'}
          </div>
        ) : (
          <div key={index} className={cn('flex', ROW_CLASS[row.kind])}>
            <span
              aria-hidden="true"
              className="w-5 shrink-0 select-none pl-1.5">
              {ROW_SIGN[row.kind]}
            </span>
            <span className="whitespace-pre-wrap break-all pr-2">
              {row.text}
            </span>
          </div>
        ),
      )}
      {shown.length < rows.length ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full rounded-none font-sans"
          onClick={() => setExpanded({ oldText, newText })}>
          Show all {formatCount(rows.length)} rows
        </Button>
      ) : null}
    </div>
  );
});

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * How each line of a unified diff is drawn. Inside a hunk a line is what its
 * first character says, counted down against the header's line counts — so
 * added text that begins `++` or removed text that begins `--` (a Markdown
 * rule, a CLI flag) is never mistaken for a file header.
 */
function unifiedLineClasses(lines: readonly string[]): string[] {
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line) => {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) {
        return 'text-muted-foreground';
      }
      if (line.startsWith('+')) {
        newLeft -= 1;
        return ADDED_CLASS;
      }
      if (line.startsWith('-')) {
        oldLeft -= 1;
        return REMOVED_CLASS;
      }
      oldLeft -= 1;
      newLeft -= 1;
      return 'text-foreground';
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      return 'text-muted-foreground';
    }
    return unifiedLineClass(line);
  });
}

/** How a line outside any hunk is drawn — decided by its first character. */
function unifiedLineClass(line: string): string {
  // Order matters: `+++` and `---` are FILE HEADERS and start with the same
  // characters as an added and a removed line. Read as content they would paint
  // every file's header as a change, which on a one-line change is most of what
  // the reader sees.
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-muted-foreground';
  }
  if (line.startsWith('@@')) {
    return 'text-muted-foreground';
  }
  if (line.startsWith('+')) {
    return ADDED_CLASS;
  }
  if (line.startsWith('-')) {
    return REMOVED_CLASS;
  }
  if (line.startsWith('diff --git') || line.startsWith('index ')) {
    return 'text-muted-foreground';
  }
  return 'text-foreground';
}

/**
 * A UNIFIED diff, as git prints one — the other shape a diff reaches this app in.
 *
 * Beside {@link DiffView} rather than in a file of its own, because the two are
 * one subject seen from two directions: that one is handed the before and after
 * of a tool call and computes nothing, this one is handed git's own rendering
 * and only colours it. Split apart they would sooner or later stop looking alike,
 * on a screen where a reader meets both.
 *
 * It COLOURS and never re-derives: the hunk arithmetic is git's, and a second
 * implementation of it here would be a chance to disagree with the tool that
 * produced the text. `wordLevel` only marks, inside lines the hunks already
 * pair, the words that differ.
 */
export function UnifiedDiff({
  diff,
  wordLevel = false,
}: {
  diff: string;
  /** Mark the words that changed inside each removed/added line pair. */
  wordLevel?: boolean;
}): React.JSX.Element {
  const lines = diff.split('\n');
  const classes = unifiedLineClasses(lines);
  const changed = wordLevel
    ? changedSpans(lines, classes)
    : new Map<number, { start: number; end: number }>();
  return (
    <div
      data-slot="unified-diff"
      className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {lines.map((line, index) => {
        const span = changed.get(index);
        return (
          <div
            key={index}
            className={`whitespace-pre-wrap break-all px-2 ${classes[index]}`}>
            {/* A non-breaking space so an empty context line still occupies one
                row — without it a blank line in the source collapses and the
                diff reads as having fewer lines than it has. */}
            {line === '' ? (
              ' '
            ) : span === undefined ? (
              line
            ) : (
              <>
                {line.slice(0, span.start)}
                <span
                  data-changed
                  className={
                    line.startsWith('-')
                      ? 'rounded-sm bg-destructive/25'
                      : 'rounded-sm bg-success/25'
                  }>
                  {line.slice(span.start, span.end)}
                </span>
                {line.slice(span.end)}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * For each removed line paired with the added line in the same place of the
 * run after it, the part of both that differs, widened to whole words.
 */
function changedSpans(
  lines: readonly string[],
  classes: readonly string[],
): Map<number, { start: number; end: number }> {
  const spans = new Map<number, { start: number; end: number }>();
  let index = 0;
  while (index < lines.length) {
    if (classes[index] !== REMOVED_CLASS) {
      index += 1;
      continue;
    }
    const removed: number[] = [];
    while (classes[index] === REMOVED_CLASS) {
      removed.push(index);
      index += 1;
    }
    const added: number[] = [];
    while (classes[index] === ADDED_CLASS) {
      added.push(index);
      index += 1;
    }
    for (
      let pair = 0;
      pair < Math.min(removed.length, added.length);
      pair += 1
    ) {
      const [oldSpan, newSpan] = differingSpans(
        lines[removed[pair]!]!,
        lines[added[pair]!]!,
      );
      spans.set(removed[pair]!, oldSpan);
      spans.set(added[pair]!, newSpan);
    }
  }
  return spans;
}

/** Where two diff lines (sign included) differ, widened to word boundaries. */
function differingSpans(
  before: string,
  after: string,
): [{ start: number; end: number }, { start: number; end: number }] {
  let start = 1;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }
  while (start > 1 && !/\s/.test(before[start - 1]!)) {
    start -= 1;
  }
  let shared = 0;
  while (
    shared < before.length - start &&
    shared < after.length - start &&
    before[before.length - 1 - shared] === after[after.length - 1 - shared]
  ) {
    shared += 1;
  }
  while (shared > 0 && !/\s/.test(before[before.length - shared]!)) {
    shared -= 1;
  }
  return [
    { start, end: before.length - shared },
    { start, end: after.length - shared },
  ];
}
