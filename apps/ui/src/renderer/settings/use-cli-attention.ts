import { useEffect, useRef, useState } from 'react';

import type { CliDetection } from '../../shared/contracts';
import { signedOutAccounts } from '../cli-sign-ins';
import { useLatestCallback } from '../components/use-latest-callback';
import { DETECTION_MAX_AGE_MS } from '../teams/use-sign-in-health';
import { type CliUpdatesController, useCliUpdates } from './use-cli-updates';

export interface CliAttention {
  updatesAvailable: number;
  signInsNeeded: number;
  /** Null until the first reading lands. */
  detections: readonly CliDetection[] | null;
  updates: CliUpdatesController;
  adopt: (detections: CliDetection[]) => void;
  /** Read again: `fresh` probes the CLIs, otherwise main may answer from its cache. */
  refresh: (fresh: boolean) => void;
}

/** The installed CLIs that said a newer version of themselves exists. */
export function cliUpdatesAvailable(
  detections: readonly CliDetection[],
): CliDetection[] {
  return detections.filter(
    (detection) => detection.found && detection.update.available === true,
  );
}

export function countCliUpdatesAvailable(
  detections: readonly CliDetection[],
): number {
  return cliUpdatesAvailable(detections).length;
}

export function countCliSignInsNeeded(
  detections: readonly CliDetection[],
): number {
  return detections.reduce(
    (total, detection) => total + signedOutAccounts(detection),
    0,
  );
}

export function signInsNeededText(count: number): string {
  return count === 1
    ? '1 account needs sign-in'
    : `${count} accounts need sign-in`;
}

type CliReadingListener = (
  request: number,
  detections: readonly CliDetection[],
) => void;

/**
 * Every reading of the CLIs this window takes reaches every hook, newest by
 * request: a sign-in finished in one place is seen by the counts and by the
 * notice report elsewhere without waiting for their own next read.
 */
const cliReadingListeners = new Set<CliReadingListener>();
let cliReadingRequests = 0;

function publishCliReading(
  request: number,
  detections: readonly CliDetection[],
): void {
  for (const listener of cliReadingListeners) {
    listener(request, detections);
  }
}

export function useCliAttention(): CliAttention {
  const [readings, setReadings] = useState<{
    updatesAvailable: number;
    signInsNeeded: number;
    detections: readonly CliDetection[] | null;
  }>({
    updatesAvailable: 0,
    signInsNeeded: 0,
    detections: null,
  });
  const live = useRef(true);
  const shown = useRef(0);

  const show = useLatestCallback(
    (request: number, detections: readonly CliDetection[]): void => {
      if (request < shown.current) {
        return;
      }
      shown.current = request;
      setReadings({
        updatesAvailable: countCliUpdatesAvailable(detections),
        signInsNeeded: countCliSignInsNeeded(detections),
        detections,
      });
    },
    [],
  );

  const adopt = useLatestCallback((detections: CliDetection[]): void => {
    publishCliReading(++cliReadingRequests, detections);
  }, []);

  const read = useLatestCallback((fresh: boolean): void => {
    const request = ++cliReadingRequests;
    void window.geniro
      .detectClis(fresh ? undefined : { maxAgeMs: DETECTION_MAX_AGE_MS })
      .then((detections) => publishCliReading(request, detections))
      .catch(() => undefined);
  }, []);

  const updates = useCliUpdates(() => read(true));

  useEffect(() => {
    live.current = true;
    const listener: CliReadingListener = (request, detections) => {
      if (live.current) {
        show(request, detections);
      }
    };
    cliReadingListeners.add(listener);
    read(false);
    const onFocus = (): void => read(false);
    window.addEventListener('focus', onFocus);
    return () => {
      live.current = false;
      cliReadingListeners.delete(listener);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return { ...readings, updates, adopt, refresh: read };
}
