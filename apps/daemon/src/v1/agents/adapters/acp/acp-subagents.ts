import { asRecord, asString } from '../../utils/json-util';
import type { BackgroundUnitOutcome } from '../adapter.types';

/**
 * SUB-AGENT SESSIONS — the frames an agent sends when it runs a sub-agent as a
 * session of its own, and a client declared it could take them.
 *
 * This is the shape of the FIRST draft of ACP's "Subagent Sessions" RFD
 * (`docs/rfds/subagents.mdx` as of 2026-08-31): a `subagent_spawned` on the
 * PARENT session announcing the child, the child's own `session/update`s under
 * the child's session id, and one `subagent_state_update` on the parent when it
 * ends. The RFD merged as UNSTABLE on 2026-09-30 with a different shape — one
 * upsert-style `subagent_update` and a `state` that is a snapshot rather than a
 * terminal enum — and no agent this client drives sends that one, so it is not
 * read here. cursor-agent 2026.10.01-e373342 sends this draft, measured with
 * the raw frames (see `CURSOR_ACP_CLIENT_META`); a later shape is a reader
 * change in this file and nowhere else.
 *
 * Agent-agnostic: the frames are the protocol's. The one thing the draft does
 * not say — which TOOL CALL launched a child — is a vendor `_meta` fact, read by
 * the adapter through `AcpDelegateProtocol.subagentToolCallId`.
 */

/** The parent-session update announcing a child session. */
export const ACP_SUBAGENT_SPAWNED = 'subagent_spawned';

/** The parent-session update ending one. */
export const ACP_SUBAGENT_STATE_UPDATE = 'subagent_state_update';

/** One `subagent_spawned`, read. */
export interface AcpSubagentSpawn {
  /** The child's own session id — what its steps arrive under. */
  childSessionId: string;
  /** The vendor `_meta`, for the adapter to read the launching call out of. */
  meta: unknown;
}

/** The terminal states the draft names. */
export type AcpSubagentState =
  'completed' | 'failed' | 'cancelled' | 'disconnected';

/** One `subagent_state_update`, read. */
export interface AcpSubagentEnd {
  childSessionId: string;
  state: AcpSubagentState;
  meta: unknown;
}

const STATES: readonly AcpSubagentState[] = [
  'completed',
  'failed',
  'cancelled',
  'disconnected',
];

/** A `subagent_spawned` update, or null when it names no child. */
export function readSubagentSpawn(
  update: Record<string, unknown>,
): AcpSubagentSpawn | null {
  const childSessionId = asString(update.subagentSessionId);
  if (childSessionId === null || childSessionId === '') {
    return null;
  }
  return { childSessionId, meta: update._meta };
}

/**
 * A `subagent_state_update`, or null when it names no child or a state the
 * draft does not define — an unknown word is not evidence the child ended.
 */
export function readSubagentEnd(
  update: Record<string, unknown>,
): AcpSubagentEnd | null {
  const childSessionId = asString(update.subagentSessionId);
  const state = asString(update.state);
  if (
    childSessionId === null ||
    childSessionId === '' ||
    state === null ||
    !(STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  return {
    childSessionId,
    state: state as AcpSubagentState,
    meta: update._meta,
  };
}

/**
 * How a child that reached `state` ended, in the transcript's vocabulary.
 *
 * `disconnected` claims NOTHING: the agent lost track of the child (its cancel
 * cascade timed out, or a replay found no record), so neither "finished" nor
 * "stopped" was observed.
 */
export function subagentOutcome(
  state: AcpSubagentState,
): BackgroundUnitOutcome | null {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    case 'disconnected':
      return null;
  }
}

/** The launching tool call a vendor `_meta` names, by the given reader. */
export function launchingCallOf(
  meta: unknown,
  read: ((meta: unknown) => string | null) | undefined,
): string | null {
  if (read === undefined || asRecord(meta) === null) {
    return null;
  }
  const id = read(meta);
  return id === null || id === '' ? null : id;
}
