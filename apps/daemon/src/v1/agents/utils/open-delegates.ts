import type {
  AgentEvent,
  BackgroundUnitOutcome,
} from '../adapters/adapter.types';
import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * Fold durable delegate declarations so session close and boot reconciliation
 * can mark missing endings untracked. A parent going away gives no CLI report
 * about how each child ended.
 *
 * TWIN PARSER: outcome outranks backgroundOpen, as in the renderer's
 * subagentBlockStatus. Metadata-only declarations make no lifecycle claim.
 */
/**
 * Which delegate a `subagent_info` payload is about, or null when it names
 * none.
 *
 * The same field {@link openDelegateIds} keys its fold on, read once here so
 * the two cannot come to disagree about what identifies a delegate: a caller
 * pairing an id with something ELSE about the row — the node that launched it,
 * which is what `ChatService.closeStrandedDelegates` needs — must select rows
 * by exactly the rule the fold selected them by, or it pairs the wrong two.
 */
export function delegateIdOf(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  const id = asString(record.id);
  return id === null || id === '' ? null : id;
}

/** A `subagent_info` row as it is read back to be folded. */
export interface DelegateRow {
  /** The column as stored — JSON text. */
  payload: unknown;
  nodeId: string | null;
}

/**
 * A delegate still declared out, and where its close has to be filed to reach
 * it: under the NODE whose rows carry it and, for one a callee sub-turn
 * launched, carrying that CALL's id — the renderer nests a call's rows under
 * its call block by the payload's `callId`, so a close without it lands
 * outside the block holding the delegate it is about.
 */
export interface StrandedDelegate {
  id: string;
  nodeId: string | null;
  callId: string | null;
}

/**
 * {@link openDelegateIds}, with each id paired to where its OWN rows were
 * filed — read off the first row naming it, which is the launch.
 */
export function strandedDelegates(
  rows: readonly DelegateRow[],
): StrandedDelegate[] {
  const payloads = rows.map((row) => parseJsonColumn(row.payload));
  const placed = new Map<
    string,
    { nodeId: string | null; callId: string | null }
  >();
  payloads.forEach((payload, index) => {
    const id = delegateIdOf(payload);
    if (id !== null && !placed.has(id)) {
      placed.set(id, {
        nodeId: rows[index]!.nodeId,
        callId: asString(asRecord(payload)?.callId),
      });
    }
  });
  return openDelegateIds(payloads).map((id) => ({
    id,
    ...(placed.get(id) ?? { nodeId: null, callId: null }),
  }));
}

/**
 * The close written for a delegate by the daemon rather than by its CLI's own
 * bracket. Built here so every writer of one produces the same row.
 */
export function delegateCloseEvent(
  id: string,
  /**
   * Without a reported ending the daemon has lost tracking, even if the
   * parent session has closed. A later report may still resolve the outcome.
   */
  outcome: BackgroundUnitOutcome | null = 'untracked',
  /** How long it ran, when the closer measured it. */
  durationMs: number | null = null,
): Extract<AgentEvent, { type: 'subagent_info' }> {
  return {
    type: 'subagent_info',
    id,
    label: null,
    kind: null,
    prompt: null,
    model: null,
    durationMs,
    tokens: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    stepsUnavailableReason: null,
    backgroundOpen: false,
    backgroundOutcome: outcome ?? 'untracked',
  };
}

/**
 * The owner fields every row a workflow node persists carries in its payload,
 * for a close written on that node's behalf — without them the renderer files
 * the close outside the call block holding the unit it closes. Empty for a
 * chat, whose rows carry neither.
 */
export function ownerFields(owner: {
  nodeId: string | null;
  callId: string | null;
}): { nodeId?: string; callId?: string } {
  return {
    ...(owner.nodeId !== null ? { nodeId: owner.nodeId } : {}),
    ...(owner.callId !== null ? { callId: owner.callId } : {}),
  };
}

export function openDelegateIds(payloads: readonly unknown[]): string[] {
  // Insertion-ordered, so the closes are written in the order the delegates
  // were launched — a re-`set` keeps a key's original position, which is what
  // makes a reopened delegate stay where it started rather than jump to the end.
  const open = new Map<string, boolean>();
  for (const payload of payloads) {
    const record = asRecord(payload);
    if (record === null) {
      continue;
    }
    const id = asString(record.id);
    if (id === null || id === '') {
      continue;
    }
    if (asString(record.backgroundOutcome) !== null) {
      open.set(id, false);
      continue;
    }
    if (typeof record.backgroundOpen === 'boolean') {
      open.set(id, record.backgroundOpen);
    }
  }
  return [...open].filter(([, isOpen]) => isOpen).map(([id]) => id);
}
