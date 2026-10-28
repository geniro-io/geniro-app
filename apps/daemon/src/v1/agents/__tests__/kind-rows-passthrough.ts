import type { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import type { KindRowsView } from '../chat.types';
import type { RunKindRowsCache } from '../services/run-kind-rows.cache';

/**
 * A `RunKindRowsCache` that holds nothing: every call reads the source afresh,
 * so a spec's fake rows are what a service sees, written before or after its
 * first read alike.
 */
export function kindRowsPassthrough(source: {
  rowsOfKinds(runId: string, kinds: readonly ItemKind[]): Promise<Item[]>;
}): RunKindRowsCache {
  return {
    rowsOf: (runId: string, kinds: readonly ItemKind[]) =>
      source.rowsOfKinds(runId, kinds),
    rowsOfView: async (runId: string, view: KindRowsView) => {
      const rows = await source.rowsOfKinds(runId, view.kinds);
      return view.keep === undefined ? rows : rows.filter(view.keep);
    },
  } as unknown as RunKindRowsCache;
}
