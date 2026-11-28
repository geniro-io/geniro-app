import {
  type InterruptCause,
  interruptCauseClause,
  parseInterruptCause,
} from '../../../utils/stop-cause';
import type {
  RestartContinuation,
  RestartContinuationCall,
  RestartContinuationFailedCall,
  RestartContinuationMonitor,
  RestartContinuationTurn,
} from '../chat.types';
import { asArray, asBoolean, asNumber, asRecord, asString } from './json-util';
import { type StoppedMonitor, stoppedMonitorsText } from './monitor-text';

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
  const written = asString(record?.cause);
  const cause = parseInterruptCause(written);
  if (written === null || cause !== written) {
    return null;
  }
  const continuation: RestartContinuation = {
    cause,
    held: asBoolean(record?.held),
    turns: asArray(record?.turns).flatMap(readTurn),
    calls: asArray(record?.calls).flatMap(readCall),
    failedCalls: asArray(record?.failedCalls).flatMap(readFailedCall),
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

export function isEmptyContinuation(
  continuation: RestartContinuation,
): boolean {
  return (
    continuation.turns.length === 0 &&
    continuation.calls.length === 0 &&
    continuation.failedCalls.length === 0 &&
    continuation.monitors.length === 0
  );
}

/**
 * Two records of one run joined — what a second boot finds still owed beside
 * what this boot adds — each entry once, the newer cause kept unless the older
 * record waits for the user's choice, which then still waits, under its cause.
 */
export function mergeRestartContinuations(
  older: RestartContinuation | null,
  newer: RestartContinuation,
): RestartContinuation {
  if (older === null) {
    return newer;
  }
  const held = older.held || newer.held;
  const turns = new Map(
    [...older.turns, ...newer.turns].map((turn) => [turn.memberId, turn]),
  );
  const failedCalls = new Map(
    [...older.failedCalls, ...newer.failedCalls].map((call) => [
      call.callId,
      call,
    ]),
  );
  const calls = new Map(
    [...older.calls, ...newer.calls]
      .filter((call) => !failedCalls.has(call.callId))
      .map((call) => [call.callId, call]),
  );
  const monitors = new Map(
    [...older.monitors, ...newer.monitors].map((monitor) => [
      monitor.id,
      monitor,
    ]),
  );
  return {
    cause: older.held ? older.cause : newer.cause,
    held,
    turns: [...turns.values()],
    calls: [...calls.values()],
    failedCalls: [...failedCalls.values()],
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
      member:
        member !== null && Number.isInteger(member) && member >= 1
          ? member
          : null,
    },
  ];
}

function readFailedCall(value: unknown): RestartContinuationFailedCall[] {
  const call = asRecord(value);
  const callId = asString(call?.callId);
  const callerMemberId = asString(call?.callerMemberId);
  const calleeMemberId = asString(call?.calleeMemberId);
  if (callId === null || callerMemberId === null || calleeMemberId === null) {
    return [];
  }
  return [
    {
      callId,
      callerMemberId,
      callerConversationId: asString(call?.callerConversationId),
      calleeMemberId,
      again: asBoolean(call?.again),
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

/**
 * The short message geniro continues a cut-off conversation with, in the same
 * session: what stopped it, that the CLI's own "the user doesn't want to
 * proceed" note does not apply, to check what is done and run the interrupted
 * command again, the calls of its own that continue or failed, and the
 * monitors that were not started again. `working` is what the conversation
 * was doing: its own turn, a call it answers, or nothing.
 */
export function restartContinuationPrompt(
  cause: InterruptCause,
  {
    working,
    calls,
    failedCalls = [],
    monitors,
    fresh = false,
    brief = null,
  }: {
    working: 'turn' | 'call' | 'idle';
    /** Its session could not be resumed: the transcript excerpt follows instead. */
    fresh?: boolean;
    /** The call's brief, which its resumed session never saved: given again. */
    brief?: string | null;
    calls: readonly { callId: string; callee: string }[];
    failedCalls?: readonly { callId: string; callee: string; again: boolean }[];
    monitors: readonly StoppedMonitor[];
  },
): string {
  const clause = interruptCauseClause(cause);
  const head = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  const resume = fresh
    ? 'Check what is already done, run the interrupted command again'
    : brief !== null
      ? "Your session holds this conversation up to this call, but this call's brief never reached it: it is given again below. Check what is already done"
      : 'Your session is intact — check what is already done, run the interrupted command again';
  const parts = [
    working === 'idle'
      ? `[geniro] ${head} while you were waiting.`
      : `[geniro] ${head} while you were working${working === 'call' ? ' on this call' : ''}. That stop was geniro's, not the user's: a "user doesn't want to proceed" or "stop and wait" note it left in your transcript does not apply. ${resume}, then carry on${working === 'call' ? ' and answer the call' : ''}. The interrupted command may still be running: check for it before you run it again.`,
  ];
  if (calls.length > 0) {
    const named = calls
      .map((call) => `${call.callId} (${call.callee})`)
      .join(', ');
    parts.push(
      calls.length === 1
        ? `Still open: ${named} continues; collect it with await_agent(${calls[0]!.callId}).`
        : `Still open: ${named} continue; collect them with await_agent.`,
    );
  }
  if (failedCalls.length > 0) {
    parts.push(failedCallsText(failedCalls));
  }
  if (monitors.length > 0) {
    parts.push(stoppedMonitorsText(monitors));
  }
  const prompt = parts.join(' ');
  return brief === null ? prompt : `${prompt}\n\nThis call's brief:\n${brief}`;
}

/** What a caller is told of its calls the boot closed failed. */
export function failedCallsText(
  calls: readonly { callId: string; callee: string; again: boolean }[],
): string {
  const named = calls
    .map(
      (call) =>
        `${call.callId} (${call.callee}) — ${call.again ? 'the daemon stopped again while it was being continued after an earlier restart' : 'it could not be continued'}`,
    )
    .join('; ');
  return `Failed and not continued: ${named}. ${calls.length === 1 ? 'Its' : 'Their'} work is unfinished — take it over or call again.`;
}
