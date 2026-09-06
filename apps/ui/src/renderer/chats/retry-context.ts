import { createContext } from 'react';

/**
 * Reopen this chat's conversation after a failed turn, or null when nothing
 * can.
 *
 * A context rather than a prop, for the reason {@link CliLoginContext} is one:
 * reaching `TranscriptItem` means threading a callback through every
 * intermediate row shell, none of which has any use for it.
 *
 * Whether the reopen would actually SUCCEED is deliberately not asked here.
 * That is a property of the run — does it hold an agent session to resume —
 * and it is a NOW question, where an error row is a durable record of a THEN:
 * a row written three turns ago would go on claiming a retryability the run may
 * since have lost. The daemon's route is the authority (`RUN_NOT_RESUMABLE`,
 * and it says so in words), which is the same division the approval chip
 * already follows for `RUN_BUSY`.
 *
 * Null when there is no active run to reopen — the row then renders as an
 * ordinary error rather than offering a button that cannot act.
 */
export const RetryContext = createContext<(() => void) | null>(null);
