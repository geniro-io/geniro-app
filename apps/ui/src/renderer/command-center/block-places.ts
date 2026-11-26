import { isNodeOffset, type NodeOffset } from './node-positions';
import type { RunRecords } from './run-records';
import { useStoredRecords } from './use-stored-records';

export const NO_PROJECT_BLOCK = 'block:none';

/** The block a thread stands in, by its project. */
export function blockIdOf(thread: { projectId: string | null }): string {
  return thread.projectId === null
    ? NO_PROJECT_BLOCK
    : `block:${thread.projectId}`;
}

export const BLOCK_PLACES_KEY = 'commandCenter.blockPositions';
export const MAX_REMEMBERED_BLOCK_PLACES = 100;

export type BlockPlaces = RunRecords<NodeOffset>;

export interface BlockPlacesStore {
  /** Where each moved project block stands, by block id, from the manager node's top-left. */
  places: BlockPlaces;
  place: (blockId: string, offset: NodeOffset) => void;
  /** Forget the places of blocks whose project has no thread on the board. */
  keepOnly: (blockIds: ReadonlySet<string>) => void;
  reset: () => void;
}

/** The project blocks the user moved on the command center's canvas, kept on this device. */
export function useBlockPlaces(): BlockPlacesStore {
  const stored = useStoredRecords(
    BLOCK_PLACES_KEY,
    isNodeOffset,
    MAX_REMEMBERED_BLOCK_PLACES,
  );
  return {
    places: stored.records,
    place: stored.set,
    keepOnly: stored.keepOnly,
    reset: stored.reset,
  };
}
