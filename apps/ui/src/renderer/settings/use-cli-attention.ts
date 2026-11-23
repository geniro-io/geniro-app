import { useEffect, useRef, useState } from 'react';

import type { CliDetection } from '../../shared/contracts';
import { signedOutAccounts } from '../cli-sign-ins';
import { useLatestCallback } from '../components/use-latest-callback';
import { DETECTION_MAX_AGE_MS } from '../teams/use-sign-in-health';
import { useCliUpdates } from './use-cli-updates';

export interface CliAttention {
  updatesAvailable: number;
  signInsNeeded: number;
  adopt: (detections: CliDetection[]) => void;
}

/** The installed CLIs that said a newer version of themselves exists. */
export function countCliUpdatesAvailable(
  detections: readonly CliDetection[],
): number {
  return detections.filter(
    (detection) => detection.found && detection.update.available === true,
  ).length;
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

export function useCliAttention(): CliAttention {
  const [readings, setReadings] = useState({
    updatesAvailable: 0,
    signInsNeeded: 0,
  });
  const live = useRef(true);
  const requested = useRef(0);
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
      });
    },
    [],
  );

  const adopt = useLatestCallback(
    (detections: CliDetection[]): void => {
      show(++requested.current, detections);
    },
    [show],
  );

  const read = (fresh: boolean): void => {
    const request = ++requested.current;
    void window.geniro
      .detectClis(fresh ? undefined : { maxAgeMs: DETECTION_MAX_AGE_MS })
      .then((detections) => {
        if (live.current) {
          show(request, detections);
        }
      })
      .catch(() => undefined);
  };

  useCliUpdates(() => read(true));

  useEffect(() => {
    live.current = true;
    read(false);
    const onFocus = (): void => read(false);
    window.addEventListener('focus', onFocus);
    return () => {
      live.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return { ...readings, adopt };
}
