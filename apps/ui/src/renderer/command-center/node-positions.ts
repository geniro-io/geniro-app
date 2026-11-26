import {
  hasFiniteNumbers,
  readRunRecords,
  type RunRecords,
} from './run-records';
import { useStoredRecords } from './use-stored-records';

/** Where a moved thread's node stands, from the manager node's top-left corner, in flow units. */
export interface NodeOffset {
  x: number;
  y: number;
}

export type NodeOffsets = RunRecords<NodeOffset>;

export const NODE_POSITIONS_KEY = 'commandCenter.nodePositions';
export const MAX_REMEMBERED_NODE_POSITIONS = 200;

export function isNodeOffset(value: unknown): value is NodeOffset {
  return hasFiniteNumbers(value, ['x', 'y']);
}

/** The places this device remembers for moved nodes, by thread; empty when none or unreadable. */
export function readNodePositions(): NodeOffsets {
  return readRunRecords(NODE_POSITIONS_KEY, isNodeOffset);
}

export interface NodePositions {
  offsets: NodeOffsets;
  place: (runId: string, offset: NodeOffset) => void;
  /** Give one thread's node back to the automatic layout. */
  forget: (runId: string) => void;
  /** Forget the places of threads that left the board. */
  keepOnly: (runIds: ReadonlySet<string>) => void;
  /** Forget every place, which gives the whole graph back to the automatic layout. */
  reset: () => void;
}

/** The nodes the user moved on the command center's canvas, kept on this device. */
export function useNodePositions(): NodePositions {
  const stored = useStoredRecords(
    NODE_POSITIONS_KEY,
    isNodeOffset,
    MAX_REMEMBERED_NODE_POSITIONS,
  );
  return {
    offsets: stored.records,
    place: stored.set,
    forget: stored.forget,
    keepOnly: stored.keepOnly,
    reset: stored.reset,
  };
}
