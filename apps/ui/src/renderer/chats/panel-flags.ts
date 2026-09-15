import { writeThreadFlag } from './thread-ui-memory';

/**
 * The right-hand agents panel, folded shut — remembered PER THREAD
 * (`thread-ui-memory.ts`), so folding it in one conversation leaves the others
 * as they were.
 */
export const AGENTS_PANEL_COLLAPSED_FLAG = 'agents-panel:collapsed';

/** The "Merged & closed" fold under the thread's own pull requests. */
export const THREAD_PULL_REQUESTS_SETTLED_FLAG =
  'agents-panel:pull-requests-settled-open';

/**
 * Show the whole list of pull requests this thread opened — in the PANEL, which
 * is the surface that can hold thirty-one of them.
 *
 * Called from the shelf above the composer, where only the current one is
 * drawn. It opens the fold as well as the panel on purpose: most of what a
 * finished thread opened is merged, so a panel revealed with its settled group
 * still shut would answer "all of them" with an empty section.
 *
 * A null run is a shelf drawn outside a thread, where there is no panel to open.
 */
export function revealThreadPullRequests(runId: string | null): void {
  if (runId === null) {
    return;
  }
  writeThreadFlag(runId, AGENTS_PANEL_COLLAPSED_FLAG, false);
  writeThreadFlag(runId, THREAD_PULL_REQUESTS_SETTLED_FLAG, true);
}

/**
 * Show every workflow this thread launched — in the PANEL, for the reason
 * above: the shelf is one line and names the one that is running.
 *
 * No second flag, unlike its neighbour: the workflow list has no fold to open,
 * because a thread launches workflows in ones and twos where it opens pull
 * requests in thirties.
 */
export function revealWorkflows(runId: string | null): void {
  if (runId === null) {
    return;
  }
  writeThreadFlag(runId, AGENTS_PANEL_COLLAPSED_FLAG, false);
}
