import { createContext } from 'react';

/**
 * Signs the chat's own CLI back in, or null when nothing can.
 *
 * A context rather than a prop, for the reason `AttachmentLoaderContext` is
 * one: reaching `TranscriptItem` means threading a callback through every
 * intermediate row shell — the turn block, the tool group, the entry view —
 * none of which have any use for it, so each would grow a prop purely to pass
 * it along. (The callback is `useMemo`'d at its source, so the memo on
 * `TranscriptItem` would survive a prop; the cost is the plumbing, not a
 * re-render.)
 *
 * Null when there is no active run to name a CLI for. The row then renders as
 * an ordinary error rather than offering a button that cannot act.
 */
export const CliLoginContext = createContext<(() => void) | null>(null);
