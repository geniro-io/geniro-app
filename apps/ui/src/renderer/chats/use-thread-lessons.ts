import { useEffect, useState } from 'react';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';

/**
 * What a thread's "Reflect now" can do: nothing new since its last reflection,
 * start one, or wait for the one still working. `unknown` until the daemon
 * answers, and when it cannot.
 */
export type ThreadLessonsMark =
  'unknown' | 'nothing_new' | 'ready' | 'reflecting';

/** How often a working reflection is asked whether it has filed its lessons. */
export const LESSONS_POLL_MS = 5_000;

/**
 * The open thread's lessons state, for its "Reflect now" button. Read when the
 * thread opens, whenever `refreshKey` moves (a reflection was just started) and
 * whenever the thread's own turn ends, and re-read while one is working, so the
 * button returns once the card lands or the thread has something new.
 */
export function useThreadLessons({
  lessonsApi,
  client,
  sourceRunId,
  refreshKey,
}: {
  lessonsApi: DaemonApis['lessons'] | null;
  client: DaemonClient | null;
  sourceRunId: string | null;
  refreshKey: number;
}): ThreadLessonsMark {
  const [reading, setReading] = useState<{
    source: string;
    mark: ThreadLessonsMark;
  } | null>(null);
  const [turnsEnded, setTurnsEnded] = useState(0);

  useEffect(() => {
    if (client === null || sourceRunId === null) {
      return;
    }
    return client.onRunStatus((event) => {
      if (
        event.runId === sourceRunId &&
        event.status !== null &&
        event.status !== 'running'
      ) {
        setTurnsEnded((count) => count + 1);
      }
    });
  }, [client, sourceRunId]);

  useEffect(() => {
    if (lessonsApi === null || sourceRunId === null) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (): void => {
      void lessonsApi
        .getThreadLessonsState({ runId: sourceRunId })
        .then((state) => {
          if (!live) {
            return;
          }
          const mark: ThreadLessonsMark =
            state.reflectionRunId != null
              ? 'reflecting'
              : state.reflectable
                ? 'ready'
                : 'nothing_new';
          setReading({ source: sourceRunId, mark });
          if (mark === 'reflecting') {
            timer = setTimeout(read, LESSONS_POLL_MS);
          }
        })
        .catch(() => {
          if (live) {
            setReading({ source: sourceRunId, mark: 'unknown' });
          }
        });
    };
    read();
    return () => {
      live = false;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [lessonsApi, sourceRunId, refreshKey, turnsEnded]);

  return reading !== null && reading.source === sourceRunId
    ? reading.mark
    : 'unknown';
}
