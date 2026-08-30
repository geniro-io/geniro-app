import { setPersistedFlag } from '../components/use-persisted-flag';

/** The right-hand agents panel, folded shut. */
export const AGENTS_PANEL_COLLAPSED_FLAG = 'chats.agentsPanelCollapsed';

/** The "Merged & closed" fold under the thread's own pull requests. */
export const THREAD_PULL_REQUESTS_SETTLED_FLAG =
  'chats.threadPullRequestsSettledOpen';

/**
 * Show the whole list of pull requests this thread opened — in the PANEL, which
 * is the surface that can hold thirty-one of them.
 *
 * Called from the shelf above the composer, where only the current one is
 * drawn. It opens the fold as well as the panel on purpose: most of what a
 * finished thread opened is merged, so a panel revealed with its settled group
 * still shut would answer "all of them" with an empty section.
 */
export function revealThreadPullRequests(): void {
  setPersistedFlag(AGENTS_PANEL_COLLAPSED_FLAG, false);
  setPersistedFlag(THREAD_PULL_REQUESTS_SETTLED_FLAG, true);
}
