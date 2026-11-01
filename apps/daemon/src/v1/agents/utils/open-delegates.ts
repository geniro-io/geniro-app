import type {
  AgentEvent,
  BackgroundUnitOutcome,
} from '../adapters/adapter.types';
import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * Which delegate a `subagent_info` payload is about, or null when it names
 * none.
 *
 * The same field {@link openDelegateIds} keys its fold on, read once here so
 * the two cannot come to disagree about what identifies a delegate: a caller
 * pairing an id with something ELSE about the row — the member that launched it,
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
  memberId: string | null;
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
  memberId: string | null;
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
    { memberId: string | null; callId: string | null }
  >();
  payloads.forEach((payload, index) => {
    const id = delegateIdOf(payload);
    if (id !== null && !placed.has(id)) {
      placed.set(id, {
        memberId: rows[index]!.memberId,
        callId: asString(asRecord(payload)?.callId),
      });
    }
  });
  return openDelegateIds(payloads).map((id) => ({
    id,
    ...(placed.get(id) ?? { memberId: null, callId: null }),
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
 * The close for a delegate whose hosting process is gone: its work is over,
 * and only how it ended is unknown, until its CLI's own record says.
 */
export function processEndedCloseEvent(
  id: string,
): Extract<AgentEvent, { type: 'subagent_info' }> {
  return { ...delegateCloseEvent(id), trackingLost: 'process-ended' };
}

/**
 * A `subagent_info` row that states facts about a delegate and nothing about
 * its lifecycle — every lifecycle field null, so the fold keeps whatever the
 * delegate's other rows said.
 */
export function delegateDeclarationEvent(
  id: string,
  facts: Partial<
    Omit<
      Extract<AgentEvent, { type: 'subagent_info' }>,
      'type' | 'id' | 'backgroundOpen' | 'backgroundOutcome'
    >
  > = {},
): Extract<AgentEvent, { type: 'subagent_info' }> {
  return {
    ...delegateCloseEvent(id),
    ...facts,
    backgroundOpen: null,
    backgroundOutcome: null,
  };
}

/**
 * The owner fields every row a team member persists carries in its payload,
 * for a close written on that member's behalf — without them the renderer files
 * the close outside the call block holding the unit it closes. Empty for a
 * chat, whose rows carry neither.
 */
export function ownerFields(owner: {
  memberId: string | null;
  callId: string | null;
}): { nodeId?: string; callId?: string } {
  return {
    ...(owner.memberId !== null ? { nodeId: owner.memberId } : {}),
    ...(owner.callId !== null ? { callId: owner.callId } : {}),
  };
}

/**
 * The delegates whose declarations leave them open, which a closer that knows
 * their process is gone has to close.
 *
 * TWIN PARSER: a stated outcome outranks `backgroundOpen`, as in the renderer's
 * `subagentBlockStatus`. A declaration stating neither makes no lifecycle
 * claim.
 */
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
