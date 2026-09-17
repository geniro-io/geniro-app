import { parseJsonColumn } from '../../agents/utils/json-util';
import type {
  CallConversation,
  CallSeedRecord,
  RunCallSeed,
} from '../graphs.types';

/** One transcript row, as much of it as the fold reads. */
export interface CallSeedRow {
  kind: string;
  payload: unknown;
}

/**
 * The number in a broker call id (`call-7` → 7), or null for anything else.
 *
 * The broker mints every id as `call-<n>` from a per-run counter, so this is
 * the one place that spelling is read back — by the seed, to continue the
 * counter past the transcript, and by the broker, to tell an id an EARLIER
 * daemon minted from one that never existed.
 */
export function callNumber(callId: string): number | null {
  const match = /^call-(\d+)$/.exec(callId);
  return match ? Number(match[1]) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Fold a run's `call_started` / `call_result` rows into what a later pass of
 * the run needs to carry its calls on — see `RunCallSeed`.
 *
 * Rows arrive in seq order, which the fold relies on twice: a `call_result`
 * lands after its `call_started` (so the session id is filed onto a record
 * that exists), and a continuation lands after the call it continued (so the
 * broker can walk the parent chain in list order). A `call_started` with no
 * result — a call the earlier daemon died in the middle of — is still a
 * record: it bumps the counter, so its id is never reissued, and it records no
 * session, so a continuation of it is refused as THREAD_UNAVAILABLE with the
 * honest sentence rather than resuming a conversation that never settled.
 *
 * The payload keys are the broker's own (`persistItem(… 'call_started' …)`
 * and its `call_result` twin) — the two writers this reads back, and the only
 * ones, so a key renamed there is renamed here.
 */
export function readCallSeed(rows: readonly CallSeedRow[]): RunCallSeed {
  const records = new Map<string, CallSeedRecord>();
  let callSeq = 0;
  for (const row of rows) {
    // The column holds JSON text; a fake or an in-memory row may hold the
    // object itself. Both read the same.
    const payload = parseJsonColumn(row.payload);
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const fields = payload as {
      callId?: unknown;
      callerNodeId?: unknown;
      calleeNodeId?: unknown;
      thread?: unknown;
      sessionId?: unknown;
    };
    const callId = readString(fields.callId);
    const callerNodeId = readString(fields.callerNodeId);
    const calleeNodeId = readString(fields.calleeNodeId);
    if (callId === null || callerNodeId === null || calleeNodeId === null) {
      continue;
    }
    const number = callNumber(callId);
    if (number !== null && number > callSeq) {
      callSeq = number;
    }
    if (row.kind === 'call_started') {
      records.set(callId, {
        callId,
        callerNodeId,
        calleeNodeId,
        thread: readString(fields.thread),
        sessionId: null,
      });
      continue;
    }
    if (row.kind === 'call_result') {
      const sessionId = readString(fields.sessionId);
      const existing = records.get(callId);
      if (existing) {
        existing.sessionId = sessionId;
      } else {
        // A result whose start is missing (a transcript window, an older
        // build) is still a settled call — resumable when it says so.
        records.set(callId, {
          callId,
          callerNodeId,
          calleeNodeId,
          thread: null,
          sessionId,
        });
      }
    }
  }
  return { callSeq, records: [...records.values()] };
}

/**
 * The CONVERSATION one call belongs to, rebuilt from the same records the
 * broker re-seeds from — or null for a call the records do not hold.
 *
 * A callee's kept process is keyed by its conversation (the first call of a
 * `thread:` lineage), not by the call, so anything that wants that process — a
 * context readout opened on one call's card — has to walk the lineage back
 * first. Walked exactly the way `CallBroker.registerRun` walks it, in record
 * order, so the two cannot disagree about which conversation a continuation
 * joined: a thread naming a call these records do not hold starts a
 * conversation of its own.
 *
 * `sessionId` is the NEWEST one any call of the conversation recorded, which is
 * the session a later continuation would resume.
 */
export function callConversation(
  records: readonly CallSeedRecord[],
  callId: string,
): CallConversation | null {
  const conversationOf = new Map<string, string>();
  for (const record of records) {
    conversationOf.set(
      record.callId,
      (record.thread === null ? null : conversationOf.get(record.thread)) ??
        record.callId,
    );
  }
  const conversationId = conversationOf.get(callId);
  const own = records.find((record) => record.callId === callId);
  if (conversationId === undefined || own === undefined) {
    return null;
  }
  const members = records.filter(
    (record) => conversationOf.get(record.callId) === conversationId,
  );
  let sessionId: string | null = null;
  for (const member of members) {
    sessionId = member.sessionId ?? sessionId;
  }
  return {
    conversationId,
    calleeNodeId: own.calleeNodeId,
    callIds: members.map((member) => member.callId),
    sessionId,
  };
}
