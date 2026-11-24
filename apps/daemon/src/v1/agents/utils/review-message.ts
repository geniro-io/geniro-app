import {
  HOST_ANSWER_REVIEW_COMMENT_TOOL,
  REVIEW_QUOTE_LINES,
  type ReviewCommentSide,
  type ReviewSnapshot,
} from '../chat.types';

interface SnapshotSource {
  number: number;
  folder: string;
  path: string;
  side: ReviewCommentSide;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  body: string;
}

export function snapshotOf(comment: SnapshotSource): ReviewSnapshot {
  return {
    number: comment.number,
    folder: comment.folder,
    path: comment.path,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    quote: cutQuote(comment.quote),
    body: comment.body,
  };
}

function cutQuote(quote: string): string {
  if (quote === '') {
    return quote;
  }
  const lines = quote.split('\n');
  if (lines.length <= REVIEW_QUOTE_LINES) {
    return quote;
  }
  const more = lines.length - REVIEW_QUOTE_LINES;
  return [
    ...lines.slice(0, REVIEW_QUOTE_LINES),
    `… ${more} more ${more === 1 ? 'line' : 'lines'}`,
  ].join('\n');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function lineLabel(comment: ReviewSnapshot): string {
  if (comment.side === 'file' || comment.startLine === null) {
    return 'whole file';
  }
  const end = comment.endLine ?? comment.startLine;
  const lines =
    end === comment.startLine
      ? `line ${comment.startLine}`
      : `lines ${comment.startLine}–${end}`;
  return `${lines} (${comment.side})`;
}

function indented(text: string, spaces: number): string[] {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => (pad + line).trimEnd());
}

/** The one message a review sends: every comment, grouped by file, with the tool to answer them by. */
export function composeReviewText(
  note: string | null,
  comments: readonly ReviewSnapshot[],
  primaryFolder: string,
): string {
  const byFile = new Map<string, ReviewSnapshot[]>();
  for (const comment of comments) {
    const key = `${comment.folder}\0${comment.path}`;
    byFile.set(key, [...(byFile.get(key) ?? []), comment]);
  }
  const files = [...byFile.values()].sort((a, b) => {
    const [left, right] = [a[0]!, b[0]!];
    const leftPrimary = left.folder === primaryFolder ? 0 : 1;
    const rightPrimary = right.folder === primaryFolder ? 0 : 1;
    return (
      leftPrimary - rightPrimary ||
      left.folder.localeCompare(right.folder) ||
      left.path.localeCompare(right.path)
    );
  });
  const lines = [
    `Review of your changes — ${plural(comments.length, 'comment', 'comments')} in ${plural(files.length, 'file', 'files')}. Address each one, then answer every`,
    `comment with the ${HOST_ANSWER_REVIEW_COMMENT_TOOL} tool: its number, what you did, and fixed or not_fixed.`,
    '',
  ];
  const trimmedNote = note?.trim() ?? '';
  if (trimmedNote !== '') {
    lines.push(...trimmedNote.split('\n').map((line) => line.trimEnd()), '');
  }
  for (const file of files) {
    const first = file[0]!;
    lines.push(
      first.folder === primaryFolder
        ? first.path
        : `${first.folder}: ${first.path}`,
    );
    for (const comment of [...file].sort((a, b) => a.number - b.number)) {
      lines.push(`  #${comment.number} · ${lineLabel(comment)}:`);
      if (comment.side !== 'file' && comment.quote !== '') {
        lines.push(...indented(comment.quote, 6));
      }
      lines.push(...indented(comment.body, 4));
    }
  }
  return lines.join('\n');
}
