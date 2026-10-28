import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * The version of the {@link payloadRefsOf} rule a run's rows were stamped
 * under (`Run.payloadRefsVersion`). Bump it when the rule changes: every run
 * stamped under another version is read through the payload again until the
 * boot sweep restamps it.
 */
export const PAYLOAD_REFS_VERSION = 1;

/**
 * The payload key each column copies — read by {@link payloadRefsOf} and by
 * `ItemDao`'s payload fallback for a run not stamped yet, so the two cannot
 * read different keys.
 */
export const PAYLOAD_REF_KEYS = {
  payloadId: 'id',
  toolNameLower: 'name',
  parentToolUseId: 'parentToolUseId',
  callId: 'callId',
} as const;

/**
 * The payload fields every run-wide lookup filters on, copied into columns of
 * their own (`Item.payloadId` …) so a lookup reads an index instead of parsing
 * every payload of the run. Only strings are kept: each one is compared with
 * strings or tested for presence, and a payload that is not JSON has none.
 */
export interface PayloadRefs {
  payloadId: string | null;
  /** Lowercased: the one lookup on it is case-blind (`ItemDao.toolCallsNamed`). */
  toolNameLower: string | null;
  parentToolUseId: string | null;
  callId: string | null;
}

export function payloadRefsOf(payload: string): PayloadRefs {
  // Only an object payload carries these keys; skipping the parse of any
  // other spares a large tool result's text a full JSON.parse on insert.
  const record = payload.startsWith('{')
    ? asRecord(parseJsonColumn(payload))
    : null;
  return {
    payloadId: asString(record?.[PAYLOAD_REF_KEYS.payloadId]),
    toolNameLower:
      asString(record?.[PAYLOAD_REF_KEYS.toolNameLower])?.toLowerCase() ?? null,
    parentToolUseId: asString(record?.[PAYLOAD_REF_KEYS.parentToolUseId]),
    callId: asString(record?.[PAYLOAD_REF_KEYS.callId]),
  };
}
