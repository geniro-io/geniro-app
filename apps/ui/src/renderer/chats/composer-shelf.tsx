import type { PullRequestRefResult } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { revealThreadPullRequests } from './panel-flags';
import { ThreadPullRequestChip } from './pull-request-row';
import { currentThreadPullRequest } from './use-thread-pull-requests';

/**
 * The row of small cards directly above the composer.
 *
 * ONE LINE, always. What sits here is whatever the thread has produced that the
 * user might want to reach without scrolling the transcript — pull requests are
 * the first of those rather than the only one, and anything added later is
 * another chip in this row, not another line above the composer, which is how
 * the area became a stack of one-item rows in the first place. A row that
 * wrapped would push the textarea down by however much the thread happened to
 * produce, so each chip takes a bounded width and gives the rest back: what
 * truncates is the TITLE, never the number, since the number identifies it.
 *
 * It renders NOTHING when it holds nothing (`empty:hidden`), so a thread that
 * has produced none of this costs no space and no gap.
 */
export function ComposerShelf({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="composer-shelf"
      className="flex items-center gap-1.5 overflow-hidden px-1 empty:hidden">
      {children}
    </div>
  );
}

/**
 * The thread's CURRENT pull request as a shelf chip, and a way to the rest.
 *
 * One chip rather than a fold that opens in place. A thread opens as many pull
 * requests as it opens — thirty-one across six repositories in the case this
 * was built for — and every one of them drawn here pushed the textarea most of
 * the way up the pane. So the shelf names the one the thread is on and the
 * button hands the list to the PANEL, which is a scrolling column built for it.
 */
export function ThreadPullRequestChips({
  results,
}: {
  results: readonly PullRequestRefResult[];
}): React.JSX.Element | null {
  const current = currentThreadPullRequest(results);
  if (current === null) {
    return null;
  }
  const repos = new Set(
    results.map((row) => `${row.ref.owner}/${row.ref.repo}`),
  );
  return (
    <>
      <ThreadPullRequestChip result={current} showRepo={repos.size > 1} />
      {results.length > 1 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="Show every pull request this thread opened"
          aria-label={`Show all ${results.length} pull requests this thread opened`}
          className="h-[26px] shrink-0 rounded-lg px-2 text-xs text-muted-foreground"
          onClick={revealThreadPullRequests}>
          All {results.length}
        </Button>
      ) : null}
    </>
  );
}
