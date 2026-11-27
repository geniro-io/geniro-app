import type { EntityManager } from '@mikro-orm/sqlite';

import {
  type InterruptCause,
  parseInterruptCause,
} from '../../../utils/stop-cause';
import type { ItemKind } from '../../runs/runs.types';
import type { ItemDao } from '../dao/item.dao';
import { asRecord, parseJsonColumn, payloadString } from './json-util';
import { monitorRowOf } from './monitor-text';

/**
 * The rows the boot reconcile writes AFTER an interruption's closing `error`,
 * which {@link interruptionOf} looks past to find it.
 *
 * `ChatService.reconcileOrphanedRuns` follows its error with `unanswerable`
 * rows, `TeamExecutorService.reconcileOrphanedRuns` adds a `status` per open
 * member turn and a `call_result` per open call, and the delegate and shell boot
 * sweeps that run after both close what the dead process left out. None of
 * them is the run carrying on; all of them are bookkeeping about how it
 * stopped. The monitor sweep's `system` row is one too, told apart by
 * {@link isMonitorCutOffRow}, since `system` rows also open turns.
 */
export const INTERRUPTION_TRAILERS: readonly ItemKind[] = [
  'unanswerable',
  'status',
  'call_result',
  'subagent_info',
  'shell_info',
];

/** A run's interruption: why the daemon stopped under it, and the row saying so. */
export interface RunInterruption {
  cause: InterruptCause;
  seq: number;
}

/**
 * Why this run was cut off, when its last word is the boot reconcile saying
 * so — the `error` row carrying `interrupted: true` (and the cause) that
 * `ChatService.reconcileOrphanedRuns` and
 * `TeamExecutorService.reconcileOrphanedRuns` write for a run the daemon
 * stopped under.
 *
 * The LAST word, not merely the newest error: a thread continued after an
 * interruption and then failed for real has moved on from it, so the newest
 * row that is not one of the reconcile's own trailers has to BE that error.
 * Null when the run was not cut off.
 */
export async function interruptionOf(
  itemDao: ItemDao,
  runId: string,
  em: EntityManager,
): Promise<RunInterruption | null> {
  let before: number | null = null;
  for (;;) {
    const rows = await itemDao.getAll(
      {
        runId,
        kind: { $nin: [...INTERRUPTION_TRAILERS] },
        ...(before === null ? {} : { seq: { $lt: before } }),
      },
      {
        orderBy: { seq: 'desc' },
        limit: LAST_WORD_PAGE,
        disableIdentityMap: true,
      },
      em,
    );
    const last = rows.find((row) => !isMonitorCutOffRow(row));
    if (last !== undefined) {
      if (last.kind !== 'error') {
        return null;
      }
      const payload = asRecord(parseJsonColumn(last.payload));
      return payload?.interrupted === true
        ? { cause: parseInterruptCause(payload.interruptCause), seq: last.seq }
        : null;
    }
    if (rows.length < LAST_WORD_PAGE) {
      return null;
    }
    before = rows[rows.length - 1]!.seq;
  }
}

const LAST_WORD_PAGE = 20;

/**
 * The boot monitor sweep's row: a `system` row whose every entry ends a
 * monitor as `interrupted` — the restart's bookkeeping, never a turn.
 */
function isMonitorCutOffRow(row: { kind: string; payload: unknown }): boolean {
  if (row.kind !== 'system') {
    return false;
  }
  const monitors = monitorRowOf(row.payload)?.monitors ?? [];
  return (
    monitors.length > 0 &&
    monitors.every(
      (monitor) =>
        monitor.event === 'end' && monitor.end?.kind === 'interrupted',
    )
  );
}

/** A call the boot reconcile closed as failed after an interruption. */
export interface InterruptedCall {
  callId: string;
  callee: string;
  again: false;
}

/** The calls the reconcile closed after `interruption`, each with its callee member. */
export async function callsClosedBy(
  itemDao: ItemDao,
  runId: string,
  interruption: RunInterruption,
  em: EntityManager,
): Promise<InterruptedCall[]> {
  const rows = await itemDao.getAll(
    { runId, kind: 'call_result', seq: { $gt: interruption.seq } },
    { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    em,
  );
  return rows.flatMap((row) => {
    const payload = parseJsonColumn(row.payload);
    const callId = payloadString(payload, 'callId');
    const callee = payloadString(payload, 'calleeNodeId');
    return callId !== null &&
      callee !== null &&
      payloadString(payload, 'status') === 'error'
      ? [{ callId, callee, again: false as const }]
      : [];
  });
}
