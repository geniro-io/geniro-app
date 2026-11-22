import type {
  ChatRunTextMatch,
  PullRequestDoneMark,
  RunPullRequestOutcomes,
} from '../chat.types';
import { textNamesPullRequest } from './pull-request-capture';

/**
 * The FTS5 query for the rows that may report a pull request done: a team's
 * delivery blocks, which name their pull request (`DONE CHECK` with its
 * `PR: #N <url>` line, `DELIVERY REPORT`).
 */
export const DONE_MARK_QUERY = '"DONE CHECK" OR "DELIVERY REPORT"';

/** At most this many matching rows are read per run. */
export const MAX_DONE_MARK_ROWS = 500;

interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** A row's text names the pull request by its address, a `gh pr` command, or `#N` alone. */
function namesPullRequest(text: string, ref: PullRequestRef): boolean {
  return (
    textNamesPullRequest(text, ref) ||
    new RegExp(`(?:^|[^\\w/&])#${ref.number}(?!\\d)`).test(text)
  );
}

function sourceOf(text: string): PullRequestDoneMark['source'] | null {
  if (text.includes('DONE CHECK')) {
    return 'done_check';
  }
  if (text.includes('DELIVERY REPORT')) {
    return 'delivery_report';
  }
  return null;
}

/**
 * Every row of the run that says this pull request was done, oldest first: its
 * first recorded outcome, and each delivery block that names it. The heading
 * must be written in capitals, as the blocks write it, so prose about "a done
 * check" is no mark.
 */
export function doneMarksOf(
  ref: PullRequestRef,
  outcomes: RunPullRequestOutcomes | undefined,
  rows: readonly ChatRunTextMatch[],
): PullRequestDoneMark[] {
  const marks: PullRequestDoneMark[] = [];
  const first = outcomes?.outcomes.at(-1);
  if (first !== undefined) {
    marks.push({
      seq: first.seq,
      at: first.at,
      source: 'record_outcome',
      memberId: first.nodeId,
    });
  }
  for (const row of rows) {
    const source = sourceOf(row.text);
    if (source === null || !namesPullRequest(row.text, ref)) {
      continue;
    }
    marks.push({
      seq: row.seq,
      at: new Date(row.created_at).toISOString(),
      source,
      memberId: row.member_id,
    });
  }
  return marks.sort((a, b) => a.seq - b.seq);
}
