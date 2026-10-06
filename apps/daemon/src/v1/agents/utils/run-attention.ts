import { type RunStatus } from '../../runs/runs.types';
import { type RunStatusEvent } from '../chat.types';

/**
 * What one daemon process last heard announced about a run — the "before" a
 * status event is compared against to tell a TRANSITION from a repeat.
 */
export interface AttentionMemory {
  status: RunStatus | undefined;
  awaiting: boolean;
}

export const NO_ATTENTION_MEMORY: AttentionMemory = {
  status: undefined,
  awaiting: false,
};

/** The two statuses a turn can END in that are news to the user. */
const NEWSWORTHY_SETTLES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
]);

/**
 * Does this status announce earn the run an UNREAD mark — and what does the
 * daemon remember about it afterwards?
 *
 * The renderer's own rule (`diffRunNotifications`) carried across, because a
 * mark the banner would not have fired for is the two surfaces disagreeing
 * about one run:
 *
 * - a turn that FINISHED or FAILED is news; one the user CANCELLED is not —
 *   they pressed Stop and know;
 * - a card going up (`awaiting` null → a kind) is news, and stays one piece of
 *   news however many later announces restate it;
 * - a compaction-only turn (`housekeeping`) and a status merely HANDED BACK
 *   (`restored`, the delegate lease expiring) are not news — both are the
 *   reasons those flags exist.
 *
 * Only a TRANSITION counts: the same terminal status announced twice, or an
 * open card re-stated on every activity announce, would otherwise re-mark a
 * thread the user had just opened. "Before" is whatever this process last heard,
 * so after a restart the first settle of a run counts — the safe direction, a
 * mark that is merely repeated rather than one that is lost.
 */
export function readAttention(
  event: RunStatusEvent,
  before: AttentionMemory,
): { earns: boolean; after: AttentionMemory } {
  const after: AttentionMemory = {
    status: event.status ?? before.status,
    awaiting:
      event.awaiting === undefined ? before.awaiting : event.awaiting !== null,
  };
  const asked = !before.awaiting && after.awaiting;
  const settled =
    event.status !== null &&
    NEWSWORTHY_SETTLES.has(event.status) &&
    event.status !== before.status &&
    event.housekeeping !== true &&
    event.restored !== true;
  return { earns: asked || settled, after };
}
