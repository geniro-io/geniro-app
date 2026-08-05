import type { ItemWire } from '../../agents/chat.types';

/** The node statuses that mean a turn stopped producing transcript. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Which mirror an item makes stale, and how urgently. */
export interface MirrorRefresh {
  /** The mirror target: null is a chat's (and a run-level) mirror. */
  nodeId: string | null;
  /** The transcript is FINAL, not merely further along — skip the throttle. */
  immediate: boolean;
}

/**
 * Does this transcript item mean a mirror is now behind — and if so, whose?
 *
 * The signal a terminal mirror re-reads on. The CLI loads its session file once
 * at startup, so a mirror only ever shows the conversation as it stood when its
 * process began; the only way it learns anything more is to be started over.
 *
 * EVERY item counts, because the CLI appends to its transcript as the turn runs
 * — probe-measured, a 34s turn grew 11 → 15 → 16 → 19 → 20 → 22 → 25 lines, one
 * step at a time. Waiting for the turn to end (which is what this used to do)
 * meant a mirror opened during a long turn sat frozen for its whole duration
 * while the chat pane beside it filled up. The re-read is expensive, so the
 * SESSION layer throttles it; this function's job is only to say what is stale.
 *
 * `immediate` marks the end of a turn, where the throttle would be wrong: there
 * will be no further item to carry the mirror the rest of the way, so the last
 * one has to land promptly. Two shapes, because the two run kinds settle
 * differently and neither can stand in for the other:
 *
 * - a CHAT turn ends with a `turn_complete` item carrying no node id, which is
 *   also the only item a chat run emits per turn that means "finished";
 * - a WORKFLOW node ends with its own terminal `status` item. The run-level
 *   `turn_complete` a workflow emits arrives ONCE, when the whole graph is
 *   done, and carries no node id — treating it as a node's settle would leave
 *   every node's mirror stale for the entire run.
 *
 * The item's own `nodeId` is the target either way: a chat's items all carry
 * null, which is what its mirror is keyed by, and a workflow node's items carry
 * that node.
 */
export function mirrorRefreshFor(item: ItemWire): MirrorRefresh {
  return { nodeId: item.nodeId, immediate: isSettling(item) };
}

function isSettling(item: ItemWire): boolean {
  if (item.kind === 'turn_complete') {
    return item.nodeId === null;
  }
  if (item.kind !== 'status' || item.nodeId === null) {
    return false;
  }
  const status =
    typeof item.payload === 'object' && item.payload !== null
      ? (item.payload as Record<string, unknown>).status
      : null;
  return typeof status === 'string' && SETTLED_STATUSES.has(status);
}
