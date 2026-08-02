import type { Item } from '../../runs/entity/item.entity';
import type { UnanswerableWire } from '../chat.types';
import type { PendingApproval } from '../services/approval-registry';

/** One never-answered request found in a stored transcript, with its owner. */
export interface UnansweredRequest {
  /** The graph node that asked; null for a single-agent chat's rows. */
  nodeId: string | null;
  payload: UnanswerableWire;
}

/** Read one string field out of an item's stored JSON payload, defensively. */
function payloadField(raw: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The `unanswerable` item payload for one swept approval.
 *
 * Trivial on purpose, and shared anyway: every settle path in the daemon — the
 * chat turn, the DAG turn, a callee sub-turn, and both turn-start failures —
 * writes this row, and a field spelled differently on one of them would leave
 * that path's card live on screen while the others closed. Built from the
 * registry entry the sweep returned, never re-derived from the transcript.
 */
export function unanswerablePayload(
  approval: PendingApproval,
): UnanswerableWire {
  return { id: approval.requestId, toolName: approval.toolName };
}

/**
 * Requests in a STORED transcript that were never answered and never closed.
 *
 * The boot-reconcile counterpart of a live sweep: the registry is in-memory,
 * so a daemon killed mid-turn drops every pending entry without writing a
 * row, and those cards would come back looking answerable forever. Here the
 * transcript itself is the record — an `approval_request` with no later
 * `approval_verdict` or `unanswerable` for the same id is a card nothing can
 * ever settle.
 *
 * Only for runs already known dead (the reconciler picked them because no
 * live handle owns them); running it on a live run would close cards a turn
 * is still waiting on.
 */
export function unansweredRequests(
  items: readonly Item[],
): UnansweredRequest[] {
  // Walked in `seq` order, LAST event per id wins. A set of "closed" ids
  // accumulated across the whole scan would be wrong for a REUSED id: a CLI
  // that restarts its request numbering on `--resume` produces
  // request→verdict→request within one run's transcript, and the second,
  // genuinely-open request would be filtered out by its predecessor's verdict —
  // leaving exactly the live-looking card this function exists to close.
  const open = new Map<string, UnansweredRequest>();
  for (const item of items) {
    const id = payloadField(item.payload, 'id');
    if (id === null) {
      continue;
    }
    if (item.kind === 'approval_request') {
      open.set(id, {
        nodeId: item.nodeId,
        payload: {
          id,
          toolName: payloadField(item.payload, 'toolName') ?? 'tool',
        },
      });
    } else if (
      item.kind === 'approval_verdict' ||
      item.kind === 'unanswerable'
    ) {
      open.delete(id);
    }
  }
  return [...open.values()];
}
