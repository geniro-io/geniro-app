import { createContext } from 'react';

import type { SubagentBlockEntry } from './transcript-groups';

/**
 * We are rendering INSIDE an enclosure that already names whose thread this
 * is — a sub-agent block.
 *
 * Three surfaces used to say "sub-agent" independently (`TurnBlock`'s block
 * caption, `ToolGroup`'s row caption, `TranscriptItem`'s per-row one), because
 * a delegate's rows sat loose in the main conversation with nothing else to
 * explain them. Inside a block titled with the delegate's own name they are
 * three repetitions of what the header just said. The block sets this so each
 * of them can stand down — the enclosure IS the affordance now.
 *
 * A context rather than a prop: the captions sit three render layers below the
 * block (block → TranscriptEntryView → TurnBlock → ToolGroup), and threading a
 * boolean through every shell in between would put it in the memo signature of
 * rows that have nothing to do with delegation.
 */
export const NestedThreadContext = createContext(false);

/**
 * Open one sub-agent's timeline and conversation in its own dialog, or null
 * where nothing can host one.
 *
 * Null is the honest default rather than a no-op function: a surface with no
 * provider — a test rendering one block on its own — renders no "open" control
 * at all, instead of one that silently does nothing when pressed. In the app
 * the provider sits above the whole transcript, so a delegate nested inside a
 * call block gets the control too.
 */
export const SubagentDetailContext = createContext<
  ((block: SubagentBlockEntry) => void) | null
>(null);
