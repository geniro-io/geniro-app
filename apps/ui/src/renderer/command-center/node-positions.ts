import { useState } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';
import {
  hasFiniteNumbers,
  keptRunRecords,
  readRunRecords,
  type RunRecords,
  withRunRecord,
  writeRunRecords,
} from './run-records';

/** Where a moved thread's node stands, from the manager node's top-left corner, in flow units. */
export interface NodeOffset {
  x: number;
  y: number;
}

export type NodeOffsets = RunRecords<NodeOffset>;

export const NODE_POSITIONS_KEY = 'commandCenter.nodePositions';
export const MAX_REMEMBERED_NODE_POSITIONS = 200;

function isNodeOffset(value: unknown): value is NodeOffset {
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
  const [offsets, setOffsets] = useState<NodeOffsets>(readNodePositions);
  const place = useLatestCallback(
    (runId: string, offset: NodeOffset): void =>
      setOffsets((current) => {
        const next = withRunRecord(
          current,
          runId,
          offset,
          MAX_REMEMBERED_NODE_POSITIONS,
        );
        writeRunRecords(NODE_POSITIONS_KEY, next);
        return next;
      }),
    [],
  );
  const forget = useLatestCallback(
    (runId: string): void =>
      setOffsets((current) => {
        if (current[runId] === undefined) {
          return current;
        }
        const next = { ...current };
        delete next[runId];
        writeRunRecords(NODE_POSITIONS_KEY, next);
        return next;
      }),
    [],
  );
  const keepOnly = useLatestCallback(
    (runIds: ReadonlySet<string>): void =>
      setOffsets((current) => {
        const next = keptRunRecords(current, runIds);
        if (next !== current) {
          writeRunRecords(NODE_POSITIONS_KEY, next);
        }
        return next;
      }),
    [],
  );
  const reset = useLatestCallback((): void => {
    writeRunRecords(NODE_POSITIONS_KEY, {});
    setOffsets({});
  }, []);
  return { offsets, place, forget, keepOnly, reset };
}
