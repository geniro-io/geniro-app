import { useEffect, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type MemoryTriageConfig,
} from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';
import { triageChoiceFor } from '../settings/memory-triage-settings';

/**
 * The manager's agent and model settings: the choice the user made last, read
 * from settings.json. A remembered CLI this machine no longer has falls back to
 * a blank choice on the first one it has. Null until the saved choice is read.
 */
export function useManagerChoice(
  cliDetections: readonly CliDetection[] | null,
): {
  choice: MemoryTriageConfig | null;
  pick: (next: MemoryTriageConfig) => void;
} {
  const [remembered, setRemembered] = useState<
    MemoryTriageConfig | null | undefined
  >(undefined);
  const [picked, setPicked] = useState<MemoryTriageConfig | null>(null);

  useEffect(() => {
    let live = true;
    void window.geniro
      .getSettings()
      .then((settings) => {
        if (live) {
          setRemembered(settings.lastManagerConfig);
        }
      })
      .catch(() => {
        if (live) {
          setRemembered(null);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const pick = useLatestCallback((next: MemoryTriageConfig): void => {
    setPicked(next);
    void window.geniro
      .updateSettings({ lastManagerConfig: next })
      .catch(() => undefined);
  }, []);

  if (picked !== null) {
    return { choice: picked, pick };
  }
  if (remembered === undefined) {
    return { choice: null, pick };
  }
  const installed: readonly CliKind[] =
    cliDetections === null
      ? []
      : cliDetections
          .filter((detection) => detection.found)
          .map((detection) => detection.kind);
  return {
    choice: triageChoiceFor(
      installed.length === 0 ? CLI_KINDS : installed,
      remembered,
    ),
    pick,
  };
}
