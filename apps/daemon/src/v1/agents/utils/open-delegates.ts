import type { AgentEvent } from '../adapters/adapter.types';
import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * The delegates a run's transcript still declares OUT, folded from its own
 * `subagent_info` rows in seq order.
 *
 * It exists because one shipped CLI announces a background delegate's LAUNCH
 * and never its ENDING. Re-measured on cursor-agent 2026.08.31-4057e58: the
 * bundle carries the same seven `cursor/*` extension methods it did in August,
 * none of which reports a delegate finishing, and a real fan-out of nine
 * reviewers produced nine `backgroundOpen: true` rows and not one close across
 * the twelve minutes its process went on living. So the transcript alone can
 * never say a cursor delegate is over, and a reader that waits for it to waits
 * forever.
 *
 * What CAN say so is the process. A cursor delegate runs INSIDE the ACP process
 * that launched it — its own permission requests arrive on the parent's session,
 * and killing that group two seconds after the turn left a delegate unable to
 * finish writing its file — so when the session closes, every delegate still out
 * has demonstrably stopped. `ChatService` folds this set at exactly that moment
 * (and once more at boot, for the closes a SIGKILLed daemon never got to write)
 * and states the ending the CLI would not.
 *
 * The RANKING mirrors the renderer's own `subagentBlockStatus`, and has to: a
 * stated `backgroundOutcome` outranks `backgroundOpen`, because a backgrounded
 * delegate's launching call is answered within the second and the outcome is
 * the only field that speaks about the WORK. A row saying neither says nothing
 * — the announcement carrying a delegate's label or its duration is not a
 * lifecycle claim, and reading it as one would close a delegate that is out.
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
 * The close written for a delegate whose process is gone: `stopped`, because
 * it never reported back and claiming it finished would be an outcome nothing
 * measured. Built here so every writer of one produces the same row.
 */
export function delegateCloseEvent(
  id: string,
  /**
   * How it ended, when the closer can say. `stopped` is the PROCESS closing —
   * a delegate lives inside it, so killing it demonstrably stopped the work.
   * `null` is the other closer: a turn ending on a CLI that never reports a
   * delegate's ending (`AdapterConfig.subagents.endingsUnreportedReason`),
   * where all that is known is that nothing more can ever be said — so the
   * block stops claiming the delegate is out and claims nothing about how it
   * finished. Reading a settle as success is what
   * {@link AgentEvent}'s own `backgroundOutcome` doc forbids.
   */
  outcome: 'stopped' | null = 'stopped',
): AgentEvent {
  return {
    type: 'subagent_info',
    id,
    label: null,
    kind: null,
    prompt: null,
    model: null,
    durationMs: null,
    tokens: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    stepsUnavailableReason: null,
    backgroundOpen: false,
    backgroundOutcome: outcome,
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
