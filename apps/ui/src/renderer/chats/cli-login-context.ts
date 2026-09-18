import { createContext } from 'react';

/**
 * Which sign-in cures the failure one transcript row reports, or null when
 * nothing can.
 *
 * It takes the row's NODE, because on a workflow run the answer differs per
 * node. Each agent node names its own CLI and its own config directory, and a
 * config directory is an ACCOUNT — a Manager and an Engineer routinely run
 * under two. This used to be one callback for the whole thread, bound to the
 * RUN's agent and profile, and a workflow run has neither: both are per node.
 * So the one error geniro knows how to cure, a lapsed account session, was the
 * one error a workflow row offered no cure for. REPORTED as a Manager dying
 * `Failed to authenticate: OAuth session expired` eighteen hours into a run,
 * over an error row with no button on it.
 *
 * A context rather than a prop, for the reason `AttachmentLoaderContext` is
 * one: reaching `TranscriptItem` means threading a callback through every
 * intermediate row shell — the turn block, the tool group, the entry view —
 * none of which have any use for it, so each would grow a prop purely to pass
 * it along. The resolver is `useMemo`'d at its source so the memo on
 * `TranscriptItem` survives; it is CALLED only on an error row, so a
 * transcript of ordinary rows never builds a closure for it.
 *
 * Null when there is no active run to name a CLI for, and the resolver itself
 * answers null for a node it cannot place (a snapshot not loaded yet, a node
 * no longer in the graph). The row then renders as an ordinary error rather
 * than offering a button that would sign the wrong account in.
 */
export type SignInResolver = (nodeId: string | null) => (() => void) | null;

export const CliLoginContext = createContext<SignInResolver | null>(null);
