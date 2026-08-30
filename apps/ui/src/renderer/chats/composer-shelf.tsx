import { useState } from 'react';

import type { PullRequestRefResult } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { ThreadPullRequestChip } from './pull-request-row';

/**
 * The row of small cards directly above the composer.
 *
 * It replaced a single pull-request LINE, and the reason is the feature that
 * outgrew it: a thread opens as many pull requests as it opens — thirty-one
 * across six repositories in the case this was built for — so the surface had
 * to stop being "the one pull request" and start being a shelf. Chips wrap, so
 * two or six read the same way, and each takes a bounded width and gives the
 * rest back: what truncates is the TITLE, never the number, since the number is
 * what identifies it.
 *
 * A shelf rather than a pull-request strip on purpose. What sits here is
 * whatever the thread has produced that the user might want to reach without
 * scrolling the transcript, and pull requests are the first of those rather
 * than the only one — anything added later is another chip in this row, not
 * another line above the composer, which is how the area became a stack of
 * one-item rows in the first place.
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
      className="flex flex-wrap items-center gap-1.5 px-1 empty:hidden">
      {children}
    </div>
  );
}

/**
 * How many chips the shelf shows before folding the rest behind a count.
 *
 * The shelf sits above the composer, and a thread with thirty-one pull requests
 * would otherwise push the textarea most of the way up the pane. Three is what
 * fits on one line at a typical width; the rest are one press away, and the
 * panel lists them all regardless.
 */
const SHELF_CHIP_LIMIT = 3;

/**
 * The pull requests this thread opened, as shelf chips — newest first, folded
 * past {@link SHELF_CHIP_LIMIT}.
 *
 * The fold is component state rather than persisted: it is a glance at a list
 * whose full form lives in the panel, so it starts folded every time rather
 * than remembering a thread where the user once expanded it.
 */
export function ThreadPullRequestChips({
  results,
}: {
  results: readonly PullRequestRefResult[];
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (results.length === 0) {
    return null;
  }
  const repos = new Set(
    results.map((row) => `${row.ref.owner}/${row.ref.repo}`),
  );
  const shown = expanded ? results : results.slice(0, SHELF_CHIP_LIMIT);
  const hidden = results.length - shown.length;
  return (
    <>
      {shown.map((result) => (
        <ThreadPullRequestChip
          key={result.ref.url}
          result={result}
          showRepo={repos.size > 1}
        />
      ))}
      {hidden > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={false}
          className="h-[26px] rounded-lg px-2 text-xs text-muted-foreground"
          onClick={() => setExpanded(true)}>
          +{hidden}
        </Button>
      ) : null}
      {expanded && results.length > SHELF_CHIP_LIMIT ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={true}
          className="h-[26px] rounded-lg px-2 text-xs text-muted-foreground"
          onClick={() => setExpanded(false)}>
          Show fewer
        </Button>
      ) : null}
    </>
  );
}
