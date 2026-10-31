import { asRecord, parseJsonColumn } from './json-util';
import { positive } from './positive-figure';
import { cliTurnDurationMs } from './wall-worked';

/** How long a callee worked inside one call, and the newest turn ending counted. */
export interface CallWork {
  ms: number;
  throughSeq: number;
}

/**
 * Count one usage row toward its call's worked time: the CLI's own duration,
 * plus the wall ledger's measure of the turn when its CLI timed nothing. A row
 * neither measured adds nothing and moves no `throughSeq`.
 *
 * TWIN PARSER: `scanCallTurns` in apps/ui/src/renderer/chats/turn-duration.ts
 * measures the turns past `throughSeq` from the same rows.
 */
export function addCallWork(
  into: Map<string, CallWork>,
  callId: string,
  seq: number,
  payload: unknown,
  wallMs: number | undefined,
): void {
  const cliMs = cliTurnDurationMs(payload);
  if (cliMs === null && !positive(wallMs)) {
    return;
  }
  const work = into.get(callId) ?? { ms: 0, throughSeq: seq };
  work.ms += (cliMs ?? 0) + (wallMs ?? 0);
  work.throughSeq = Math.max(work.throughSeq, seq);
  into.set(callId, work);
}

/** A stored row as {@link callWorkedMsByStart} reads it. */
interface StoredRow {
  seq: number;
  kind: string;
  payload: string;
}

/**
 * Each call's worked time keyed by the seq of its `call_started` row — the key
 * a waterfall call span carries — over the rows at or below `throughSeq`.
 */
export function callWorkedMsByStart(
  starts: readonly StoredRow[],
  usageRows: readonly StoredRow[],
  wallBySeq: ReadonlyMap<number, number>,
  throughSeq: number,
): Map<number, number> {
  const work = new Map<string, CallWork>();
  for (const row of usageRows) {
    if (row.seq > throughSeq) {
      continue;
    }
    const payload = asRecord(parseJsonColumn(row.payload));
    const callId = payload?.callId;
    if (typeof callId === 'string') {
      addCallWork(work, callId, row.seq, payload, wallBySeq.get(row.seq));
    }
  }
  const out = new Map<number, number>();
  for (const row of starts) {
    if (row.kind !== 'call_started' || row.seq > throughSeq) {
      continue;
    }
    const callId = asRecord(parseJsonColumn(row.payload))?.callId;
    const ms = typeof callId === 'string' ? work.get(callId)?.ms : undefined;
    if (ms !== undefined) {
      out.set(row.seq, ms);
    }
  }
  return out;
}
