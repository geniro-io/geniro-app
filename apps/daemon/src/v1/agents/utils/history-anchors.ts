import type {
  CallResultPayload,
  CallStartedPayload,
  ItemWire,
  PageBounds,
} from '../chat.types';
import { payloadString } from './json-util';

/**
 * Which rows OUTSIDE a page of transcript the rows IN it need, to fold exactly
 * as they would over the whole conversation — the `anchors` of
 * `GET /v1/chats/:runId/items`.
 *
 * A client holds a window of a long conversation, and the structure a row
 * belongs to is routinely stated above it: a call's `call_started` (its brief,
 * its caller, how its conversation continues), a delegate's launching tool call
 * (its name, its brief), a tool result's call, a workflow's first announcement
 * (its name). Without those rows the client could only draw the window's rows
 * as loose turns or rebuild the structure by guessing.
 *
 * Only rows the page REFERENCES are anchored, so a call or delegate that left
 * no trace in the page adds nothing: the window is still for drawing, and what
 * a run holds as a whole is a separate question with a separate route.
 */

/** What one page refers to without holding. */
export interface AnchorNeeds {
  /** Every call id a row of the page names (a call's whole conversation is resolved later). */
  callIds: Set<string>;
  /** Every delegate a row of the page belongs to or declares. */
  delegateIds: Set<string>;
  /**
   * Tool calls the page needs and does not hold: answered here, launched a
   * delegate or a workflow. A call precedes everything that names it, so these
   * are only ever above the page.
   */
  toolCallIds: Set<string>;
  /** Replies to tool calls the page holds unanswered — only ever below it. */
  pendingResultIds: Set<string>;
  /**
   * Replies to the delegates and workflows the page names. On either side: a
   * backgrounded delegate's launch is answered at once while its rows go on.
   */
  launchResultIds: Set<string>;
  /** Every dynamic workflow the page announces. */
  workflowIds: Set<string>;
}

/** The first and last seq of a page, or null for an empty one (which needs nothing). */
export function pageBoundsOf(page: readonly ItemWire[]): PageBounds | null {
  if (page.length === 0) {
    return null;
  }
  let firstSeq = page[0]!.seq;
  let lastSeq = firstSeq;
  for (const item of page) {
    firstSeq = Math.min(firstSeq, item.seq);
    lastSeq = Math.max(lastSeq, item.seq);
  }
  return { firstSeq, lastSeq };
}

export function isOutside(seq: number, bounds: PageBounds): boolean {
  return seq < bounds.firstSeq || seq > bounds.lastSeq;
}

/**
 * A call row's field, by a key the broker's payload types declare — so a key
 * renamed where the broker writes it fails to compile where it is read.
 */
export function callField(
  payload: unknown,
  key: keyof CallStartedPayload | keyof CallResultPayload,
): string | null {
  return payloadString(payload, key);
}

/**
 * What a page's rows name that the page does not hold.
 *
 * TWIN PARSER: `unplacedStructureOf` in
 * apps/ui/src/renderer/chats/history-anchors.ts asks the same of a live row.
 */
export function anchorNeedsOf(page: readonly ItemWire[]): AnchorNeeds {
  const callIds = new Set<string>();
  const delegateIds = new Set<string>();
  const workflowIds = new Set<string>();
  const callsHeld = new Set<string>();
  const resultsHeld = new Set<string>();
  for (const item of page) {
    const callId = payloadString(item.payload, 'callId');
    if (callId !== null) {
      callIds.add(callId);
    }
    // A continuation names the call it continues, which is the same
    // conversation whether or not any row of the earlier call is in the page.
    const thread =
      item.kind === 'call_started' ? callField(item.payload, 'thread') : null;
    if (thread !== null) {
      callIds.add(thread);
    }
    // TWIN PARSER: `subagentIdOf` in apps/ui/src/renderer/chats/subagent-payload.ts
    // — a delegate's own rows carry the id of the call that launched it.
    const delegate = payloadString(item.payload, 'parentToolUseId');
    if (delegate !== null) {
      delegateIds.add(delegate);
    }
    const id = payloadString(item.payload, 'id');
    if (id === null) {
      continue;
    }
    if (item.kind === 'subagent_info') {
      delegateIds.add(id);
    } else if (item.kind === 'workflow_info') {
      workflowIds.add(id);
    } else if (item.kind === 'tool_call') {
      callsHeld.add(id);
    } else if (item.kind === 'tool_result') {
      resultsHeld.add(id);
    }
  }
  const launched = [...delegateIds, ...workflowIds];
  const toolCallIds = new Set(
    [...resultsHeld, ...launched].filter((id) => !callsHeld.has(id)),
  );
  const launchResultIds = new Set(
    launched.filter((id) => !resultsHeld.has(id)),
  );
  const pendingResultIds = new Set(
    [...callsHeld].filter(
      (id) => !resultsHeld.has(id) && !launchResultIds.has(id),
    ),
  );
  return {
    callIds,
    delegateIds,
    toolCallIds,
    pendingResultIds,
    launchResultIds,
    workflowIds,
  };
}

/** A `call_started` row reduced to what chains are built from. */
export interface CallStart {
  callId: string;
  thread: string | null;
}

export function callStartOf(item: ItemWire): CallStart | null {
  if (item.kind !== 'call_started') {
    return null;
  }
  const callId = callField(item.payload, 'callId');
  return callId === null
    ? null
    : { callId, thread: callField(item.payload, 'thread') };
}

/**
 * Every call in the CONVERSATIONS the referenced calls belong to — a call
 * continuing an earlier one's `thread` joins it, transitively, in both
 * directions.
 *
 * TWIN PARSER: `resolveCallChains` in
 * apps/ui/src/renderer/chats/transcript-groups.ts. The joining rule must be the
 * renderer's exactly — a parent must be a call something knows of and, where
 * both carry the daemon's `call-<n>` numbering, an EARLIER one — because an
 * anchor set built under a looser rule hands the client a conversation it will
 * not chain, and that conversation's card then draws on its own.
 */
export function conversationCallIds(
  starts: readonly CallStart[],
  referenced: ReadonlySet<string>,
): Set<string> {
  const parents = new Map<string, string | null>();
  for (const start of starts) {
    if (!parents.has(start.callId)) {
      parents.set(start.callId, start.thread);
    }
  }
  const joins = (child: string, parent: string | null): parent is string => {
    if (parent === null || !parents.has(parent)) {
      return false;
    }
    const a = callNumberOf(parent);
    const b = callNumberOf(child);
    return a === null || b === null ? parent !== child : a < b;
  };
  const rootOf = (callId: string): string => {
    const seen = new Set<string>([callId]);
    let current = callId;
    for (;;) {
      const parent = parents.get(current) ?? null;
      if (!joins(current, parent) || seen.has(parent)) {
        return current;
      }
      seen.add(parent);
      current = parent;
    }
  };
  const roots = new Set([...referenced].map(rootOf));
  const members = new Set<string>(referenced);
  for (const callId of parents.keys()) {
    if (roots.has(rootOf(callId))) {
      members.add(callId);
    }
  }
  return members;
}

function callNumberOf(callId: string): number | null {
  const digits = /^call-(\d+)$/.exec(callId);
  return digits ? Number(digits[1]) : null;
}

/**
 * The first and the last row about each workflow, keyed by the workflow.
 *
 * The first is where a workflow states its NAME and nothing else, and the last
 * carries the roster as it now stands — the renderer takes the roster whole
 * from the newest announcement, so the rows between add nothing it reads.
 */
export function workflowEdgeRows(
  rows: readonly ItemWire[],
  workflowIds: ReadonlySet<string>,
): ItemWire[] {
  const first = new Map<string, ItemWire>();
  const last = new Map<string, ItemWire>();
  for (const row of rows) {
    const id = payloadString(row.payload, 'id');
    if (id === null || !workflowIds.has(id)) {
      continue;
    }
    const earliest = first.get(id);
    if (earliest === undefined || row.seq < earliest.seq) {
      first.set(id, row);
    }
    const latest = last.get(id);
    if (latest === undefined || row.seq > latest.seq) {
      last.set(id, row);
    }
  }
  // A workflow announced once has one row as both its first and its last.
  return [
    ...new Map(
      [...first.values(), ...last.values()].map((row) => [row.id, row]),
    ).values(),
  ];
}

/** Rows whose payload's own `id` is one of `ids`. */
export function rowsWithId(
  rows: readonly ItemWire[],
  ids: ReadonlySet<string>,
): ItemWire[] {
  return rows.filter((row) => {
    const id = payloadString(row.payload, 'id');
    return id !== null && ids.has(id);
  });
}

/** Rows naming a call of `callIds` in their payload. */
export function rowsOfCalls(
  rows: readonly ItemWire[],
  callIds: ReadonlySet<string>,
): ItemWire[] {
  return rows.filter((row) => {
    const callId = callField(row.payload, 'callId');
    return callId !== null && callIds.has(callId);
  });
}
