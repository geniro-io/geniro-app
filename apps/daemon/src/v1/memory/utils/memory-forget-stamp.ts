import type { Memory } from '../entity/memory.entity';

/**
 * What forgetting writes besides the status, on every forget path — by hand,
 * by an agent, in bulk or in a cleanup batch. A forget outside a batch clears
 * the batch id, so an older batch's undo never brings the row back.
 */
export function forgottenStamp(at: Date, batchId: string | null) {
  return { forgottenAt: at, forgetBatchId: batchId };
}

/**
 * What restoring writes besides the status, on every restore path. A restored
 * source of a merge stops counting towards the merged entry.
 */
export function restoredStamp(at: Date) {
  return {
    forgottenAt: null,
    forgetBatchId: null,
    restoredAt: at,
    mergedIntoId: null,
  };
}

/** {@link forgottenStamp} as the stored columns, for a statement outside the entity. */
export function forgottenColumns(at: Date, batchId: string | null) {
  return { forgotten_at: at.getTime(), forget_batch_id: batchId };
}

/** {@link restoredStamp} as the stored columns, for a statement outside the entity. */
export function restoredColumns(at: Date) {
  return {
    forgotten_at: null,
    forget_batch_id: null,
    restored_at: at.getTime(),
    merged_into_id: null,
  };
}

export function markForgotten(
  row: Memory,
  at: Date,
  batchId: string | null = null,
): void {
  Object.assign(row, forgottenStamp(at, batchId));
}

export function markRestored(row: Memory, at: Date): void {
  Object.assign(row, restoredStamp(at));
}
