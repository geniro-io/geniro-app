import type {
  RestartContinuation,
  RestartContinuationCall,
  RestartContinuationMonitor,
  RestartContinuationTurn,
} from '../chat.types';
import { asArray, asNumber, asRecord, asString } from './json-util';

/**
 * The run row's continuation record (`Run.restartContinuation`), read back
 * defensively, as `readPersistedResetWakes` reads its column: an entry that
 * cannot say what it continues is dropped, and a record with nothing left in
 * it reads as none.
 */
export function readRestartContinuation(
  json: string | null,
): RestartContinuation | null {
  if (json === null || json === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const cause = asString(record?.cause);
  if (cause !== 'self-update' && cause !== 'restart') {
    return null;
  }
  const continuation: RestartContinuation = {
    cause,
    turns: asArray(record?.turns).flatMap(readTurn),
    calls: asArray(record?.calls).flatMap(readCall),
    monitors: asArray(record?.monitors).flatMap(readMonitor),
  };
  return isEmptyContinuation(continuation) ? null : continuation;
}

/** The column value for a record — null once nothing in it is owed. */
export function restartContinuationColumn(
  continuation: RestartContinuation | null,
): string | null {
  return continuation === null || isEmptyContinuation(continuation)
    ? null
    : JSON.stringify(continuation);
}

export function isEmptyContinuation(continuation: RestartContinuation): boolean {
  return (
    continuation.turns.length === 0 &&
    continuation.calls.length === 0 &&
    continuation.monitors.length === 0
  );
}

/**
 * Two records of one run joined — what a second boot finds still owed beside
 * what this boot adds — each entry once, the newer cause kept.
 */
export function mergeRestartContinuations(
  older: RestartContinuation | null,
  newer: RestartContinuation,
): RestartContinuation {
  if (older === null) {
    return newer;
  }
  const turns = new Map(
    [...older.turns, ...newer.turns].map((turn) => [turn.memberId, turn]),
  );
  const calls = new Map(
    [...older.calls, ...newer.calls].map((call) => [call.callId, call]),
  );
  const monitors = new Map(
    [...older.monitors, ...newer.monitors].map((monitor) => [
      monitor.id,
      monitor,
    ]),
  );
  return {
    cause: newer.cause,
    turns: [...turns.values()],
    calls: [...calls.values()],
    monitors: [...monitors.values()],
  };
}

function readTurn(value: unknown): RestartContinuationTurn[] {
  const memberId = asString(asRecord(value)?.memberId);
  return memberId === null ? [] : [{ memberId }];
}

function readCall(value: unknown): RestartContinuationCall[] {
  const call = asRecord(value);
  const callId = asString(call?.callId);
  const callerMemberId = asString(call?.callerMemberId);
  const calleeMemberId = asString(call?.calleeMemberId);
  const conversationId = asString(call?.conversationId);
  const mode = asString(call?.mode);
  if (
    callId === null ||
    callerMemberId === null ||
    calleeMemberId === null ||
    conversationId === null ||
    mode === null
  ) {
    return [];
  }
  const member = asNumber(call?.member);
  return [
    {
      callId,
      callerMemberId,
      callerConversationId: asString(call?.callerConversationId),
      calleeMemberId,
      conversationId,
      mode,
      sessionId: asString(call?.sessionId),
      member: member !== null && Number.isInteger(member) && member >= 1 ? member : null,
    },
  ];
}

function readMonitor(value: unknown): RestartContinuationMonitor[] {
  const monitor = asRecord(value);
  const id = asString(monitor?.id);
  const description = asString(monitor?.description);
  if (id === null || description === null) {
    return [];
  }
  const remainingMs = asNumber(monitor?.remainingMs);
  return [
    {
      memberId: asString(monitor?.memberId),
      conversationId: asString(monitor?.conversationId),
      id,
      description,
      command: asString(monitor?.command),
      remainingMs:
        remainingMs !== null && remainingMs >= 0 ? remainingMs : null,
    },
  ];
}
