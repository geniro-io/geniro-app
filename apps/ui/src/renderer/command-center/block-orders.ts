import { useLatestCallback } from '../components/use-latest-callback';
import type { RunRecords } from './run-records';
import { useStoredRecords } from './use-stored-records';

export const BLOCK_ORDERS_KEY = 'commandCenter.blockOrders';
export const MAX_REMEMBERED_BLOCK_ORDERS = 100;

/** The order the user set for each project block's threads, by block id, as run ids. */
export type BlockOrders = RunRecords<readonly string[]>;

function isOrder(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * `automatic` in the user's `stored` order: the threads it names stand as it
 * names them, and each other thread joins before the first named one that the
 * automatic order puts after it, else at the end.
 */
export function orderedWithin(
  automatic: readonly string[],
  stored: readonly string[] | undefined,
): string[] {
  if (stored === undefined) {
    return [...automatic];
  }
  const rank = new Map(automatic.map((id, index) => [id, index]));
  const result = [...new Set(stored)].filter((id) => rank.has(id));
  const named = new Set(result);
  for (const id of automatic) {
    if (named.has(id)) {
      continue;
    }
    const before = result.findIndex(
      (other) => named.has(other) && rank.get(other)! > rank.get(id)!,
    );
    result.splice(before === -1 ? result.length : before, 0, id);
  }
  return result;
}

/** `orders` without the threads outside `runIds`, and without the blocks left empty — the same object when nothing went. */
export function prunedOrders(
  orders: BlockOrders,
  runIds: ReadonlySet<string>,
): BlockOrders {
  let changed = false;
  const next: Record<string, readonly string[]> = {};
  for (const [blockId, order] of Object.entries(orders)) {
    const kept = order.filter((id) => runIds.has(id));
    if (kept.length !== order.length) {
      changed = true;
    }
    if (kept.length > 0) {
      next[blockId] = kept.length === order.length ? order : kept;
    }
  }
  return changed ? next : orders;
}

export interface BlockOrdersStore {
  orders: BlockOrders;
  /** The threads of one block, in the order the user dropped them into. */
  order: (blockId: string, runIds: readonly string[]) => void;
  /** Forget the threads that left the board. */
  keepOnly: (runIds: ReadonlySet<string>) => void;
  reset: () => void;
}

/** The order the user set for threads inside project blocks, kept on this device. */
export function useBlockOrders(): BlockOrdersStore {
  const stored = useStoredRecords(
    BLOCK_ORDERS_KEY,
    isOrder,
    MAX_REMEMBERED_BLOCK_ORDERS,
  );
  const keepOnly = useLatestCallback(
    (runIds: ReadonlySet<string>): void =>
      stored.update((current) => prunedOrders(current, runIds)),
    [],
  );
  return {
    orders: stored.records,
    order: stored.set,
    keepOnly,
    reset: stored.reset,
  };
}
