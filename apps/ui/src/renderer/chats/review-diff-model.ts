import {
  changedSpans,
  type DiffLineKind,
  type WordSpan,
} from './diff-word-spans';

export type { WordSpan } from './diff-word-spans';

export type DiffRowKind = 'context' | 'added' | 'removed' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context: string;
  rows: DiffRow[];
}

export interface ParsedFileDiff {
  hunks: DiffHunk[];
  notes: string[];
  binary: boolean;
  truncatedLines: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const TRUNCATION_NOTICE =
  /^… (\d+) more lines — open the file to read the rest\.$/;
const BINARY_NOTICE = /^Binary files .+ differ$/;
const BINARY_PATCH = 'GIT binary patch';

const SIGN: Record<DiffRowKind, string> = {
  context: ' ',
  added: '+',
  removed: '-',
  note: ' ',
};

export function parseFileDiff(diff: string | null): ParsedFileDiff {
  if (diff === null) {
    return { hunks: [], notes: [], binary: false, truncatedLines: null };
  }
  const lines = diff.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') {
    end -= 1;
  }
  let truncatedLines: number | null = null;
  const notice = end > 0 ? TRUNCATION_NOTICE.exec(lines[end - 1]!) : null;
  if (notice !== null) {
    truncatedLines = Number(notice[1]);
    end -= 1;
    while (end > 0 && lines[end - 1] === '') {
      end -= 1;
    }
  }

  const notes: string[] = [];
  const hunks: DiffHunk[] = [];
  let binary = false;
  let current: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNumber = 0;
  let newNumber = 0;
  let oldMode: string | null = null;
  for (let index = 0; index < end; index += 1) {
    const line = lines[index]!;
    const header = HUNK_HEADER.exec(line);
    if (header !== null && oldLeft <= 0 && newLeft <= 0) {
      current = hunkOf(header);
      hunks.push(current);
      oldLeft = current.oldLines;
      newLeft = current.newLines;
      oldNumber = current.oldStart;
      newNumber = current.newStart;
      continue;
    }
    if (current === null) {
      if (line.startsWith('rename from ')) {
        notes.push(`Renamed from ${line.slice('rename from '.length)}`);
      } else if (line.startsWith('copy from ')) {
        notes.push(`Copied from ${line.slice('copy from '.length)}`);
      } else if (line.startsWith('old mode ')) {
        oldMode = line.slice('old mode '.length);
      } else if (line.startsWith('new mode ')) {
        if (oldMode !== null) {
          notes.push(
            `Mode changed ${oldMode} → ${line.slice('new mode '.length)}`,
          );
        }
        oldMode = null;
      } else if (BINARY_NOTICE.test(line) || line === BINARY_PATCH) {
        binary = true;
        break;
      }
      continue;
    }
    if (line.startsWith('\\')) {
      current.rows.push({
        kind: 'note',
        oldLine: null,
        newLine: null,
        text: line,
      });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      continue;
    }
    if (line.startsWith('+')) {
      current.rows.push({
        kind: 'added',
        oldLine: null,
        newLine: newNumber,
        text: line.slice(1),
      });
      newNumber += 1;
      newLeft -= 1;
    } else if (line.startsWith('-')) {
      current.rows.push({
        kind: 'removed',
        oldLine: oldNumber,
        newLine: null,
        text: line.slice(1),
      });
      oldNumber += 1;
      oldLeft -= 1;
    } else {
      current.rows.push({
        kind: 'context',
        oldLine: oldNumber,
        newLine: newNumber,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
      oldNumber += 1;
      newNumber += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return { hunks: binary ? [] : hunks, notes, binary, truncatedLines };
}

function hunkOf(header: RegExpExecArray): DiffHunk {
  return {
    oldStart: Number(header[1]),
    oldLines: header[2] === undefined ? 1 : Number(header[2]),
    newStart: Number(header[3]),
    newLines: header[4] === undefined ? 1 : Number(header[4]),
    context: (header[5] ?? '').trim(),
    rows: [],
  };
}

export function pairedWordSpans(hunk: DiffHunk): Map<number, WordSpan[]> {
  const lines = hunk.rows.map((row) => SIGN[row.kind] + row.text);
  const kinds = hunk.rows.map((row): DiffLineKind => {
    if (row.kind === 'removed') {
      return 'removed';
    }
    return row.kind === 'added' ? 'added' : 'other';
  });
  const spans = new Map<number, WordSpan[]>();
  for (const [index, span] of changedSpans(lines, kinds)) {
    if (span.end > span.start) {
      spans.set(index, [{ start: span.start - 1, end: span.end - 1 }]);
    }
  }
  return spans;
}

export interface CommentAnchorInput {
  side: 'new' | 'old' | 'file';
  startLine: number | null;
  endLine: number | null;
  quote: string;
}

export type CommentAnchor =
  | { kind: 'file' }
  | { kind: 'line'; side: 'new' | 'old'; startLine: number; endLine: number }
  | { kind: 'outdated' };

interface SideRow {
  number: number;
  text: string;
}

export function anchorComment(
  comment: CommentAnchorInput,
  hunks: readonly DiffHunk[],
): CommentAnchor {
  if (comment.side === 'file') {
    return { kind: 'file' };
  }
  const rows = sideRows(hunks, comment.side);
  const wanted = comment.quote.split('\n').map((line) => line.trimEnd());
  const matches: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (matchesAt(rows, index, wanted)) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    return { kind: 'outdated' };
  }
  const chosen = rows[nearestMatch(rows, matches, comment.startLine)]!.number;
  return {
    kind: 'line',
    side: comment.side,
    startLine: chosen,
    endLine: chosen + wanted.length - 1,
  };
}

function sideRows(hunks: readonly DiffHunk[], side: 'new' | 'old'): SideRow[] {
  const rows: SideRow[] = [];
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      const number = side === 'new' ? row.newLine : row.oldLine;
      if (number !== null) {
        rows.push({ number, text: row.text.trimEnd() });
      }
    }
  }
  return rows;
}

function matchesAt(
  rows: readonly SideRow[],
  start: number,
  wanted: readonly string[],
): boolean {
  const first = rows[start]!.number;
  return wanted.every((text, offset) => {
    const row = rows[start + offset];
    return (
      row !== undefined && row.number === first + offset && row.text === text
    );
  });
}

function nearestMatch(
  rows: readonly SideRow[],
  matches: readonly number[],
  target: number | null,
): number {
  if (target === null) {
    return matches[0]!;
  }
  let best = matches[0]!;
  for (const index of matches) {
    if (
      Math.abs(rows[index]!.number - target) <
      Math.abs(rows[best]!.number - target)
    ) {
      best = index;
    }
  }
  return best;
}
