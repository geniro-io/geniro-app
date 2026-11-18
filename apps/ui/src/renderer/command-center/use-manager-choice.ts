import { useEffect, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type ManagerConfig,
} from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';
import { triageChoiceFor } from '../settings/memory-triage-settings';

/**
 * The manager's start settings: the choice the user made last, read from
 * settings.json. A remembered CLI this machine no longer has falls back to a
 * blank choice on the first one it has, which keeps the auto-compact threshold
 * (one value for every CLI) and drops the approval (a mode of the old CLI).
 * Null until the saved choice is read.
 */
export function useManagerChoice(
  cliDetections: readonly CliDetection[] | null,
): {
  choice: ManagerConfig | null;
  pick: (next: ManagerConfig) => void;
} {
  const [remembered, setRemembered] = useState<
    ManagerConfig | null | undefined
  >(undefined);
  const [picked, setPicked] = useState<ManagerConfig | null>(null);

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

  const pick = useLatestCallback((next: ManagerConfig): void => {
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
    choice: managerChoiceFor(
      installed.length === 0 ? CLI_KINDS : installed,
      remembered,
    ),
    pick,
  };
}

function managerChoiceFor(
  agents: readonly CliKind[],
  remembered: ManagerConfig | null,
): ManagerConfig | null {
  const base = triageChoiceFor(agents, remembered);
  if (base === null) {
    return null;
  }
  const approval =
    remembered !== null && remembered.agent === base.agent
      ? remembered.approval
      : null;
  return {
    ...base,
    approval,
    autoCompactPercent: remembered?.autoCompactPercent ?? null,
  };
}
