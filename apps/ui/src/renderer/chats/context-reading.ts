import { useCallback, useRef } from 'react';

/** One chat's context figures, as the meter draws them. */
export interface ContextReading {
  /** Prompt-side tokens of the latest request. */
  tokens: number;
  /** The model's own window, or null when the CLI never reported one. */
  window: number | null;
}

/**
 * The last context reading seen for each chat, so switching threads does not
 * take the ring down with the transcript.
 *
 * REPORTED as "когда я переключаюсь между чатами, кружочек, в котором показан
 * текущий контекст, отстаёт — на какой-то момент он показывает контекст
 * предыдущего чата, а потом обновляется". The cause is that the reading is
 * DERIVED from the loaded transcript (`computeAgentActivity(items)`), and a
 * switch clears the items and refetches them — so between the two there is no
 * reading at all. Measured in the running app at a 15ms sample: the ring read
 * `43.1k of 1M` over 4 rows, then vanished with the rows, then came back as
 * `44k of 1M` over 10. On a thread big enough for that fetch to take a moment,
 * the gap is what a reader sees, and whichever of the two frames their eye
 * catches, the ring is telling them about a chat other than the one whose name
 * is above it.
 *
 * Keyed by RUN, which is the whole of the correctness argument: a remembered
 * figure can only ever be re-shown under the chat it was taken from, so this
 * cannot produce the symptom it fixes. It is a ref rather than state because
 * nothing should re-render when a reading is filed — the value is read during
 * the render that needs it, and by then the write from an earlier commit has
 * happened.
 *
 * What it does NOT do is invent a figure for a chat this session has never
 * opened: there is no reading to remember, and that is the honest reading of
 * "we have not measured this thread yet". That gap is closed from the other
 * end now — the daemon files every reading the CLI reports on the RUN ROW
 * (`Run.contextTokens`), so a cold window has a figure without this ever having
 * seen the chat. This stays the LAST fallback, for the one stretch the row
 * cannot cover: a switch whose refetch is still in flight, where the run being
 * shown has changed and its row has not arrived.
 */
export function useContextReadings(): {
  /** File the reading currently on screen for a run. */
  remember: (runId: string, reading: ContextReading | null) => void;
  /** What that run last read, or null if it has not been measured here. */
  recall: (runId: string | null) => ContextReading | null;
  /** Drop a run's reading — for a thread that no longer exists. */
  forget: (runId: string) => void;
} {
  const readings = useRef(new Map<string, ContextReading>());

  const remember = useCallback(
    (runId: string, reading: ContextReading | null): void => {
      // A null is "nothing measured right now", which is exactly the state this
      // exists to paper over — so it never OVERWRITES a reading. The entry is
      // dropped by `forget` alone, on a run that is gone.
      if (reading === null) {
        return;
      }
      readings.current.set(runId, reading);
    },
    [],
  );

  const recall = useCallback(
    (runId: string | null): ContextReading | null =>
      runId === null ? null : (readings.current.get(runId) ?? null),
    [],
  );

  const forget = useCallback((runId: string): void => {
    readings.current.delete(runId);
  }, []);

  return { remember, recall, forget };
}
