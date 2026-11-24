import { useEffect, useState } from 'react';

import { type ChangelogRelease, planWhatsNew } from '../../shared/changelog';
import { useLatestCallback } from '../components/use-latest-callback';

export interface WhatsNewController {
  /** The releases to show; empty while the dialog is shut. */
  releases: readonly ChangelogRelease[];
  /** The version the profile last saw, which the shown releases start after. */
  since: string | null;
  /** The running version the shown releases end at; null while the dialog is shut. */
  current: string | null;
  /** Close the dialog and record the running version as seen. */
  dismiss: () => void;
}

/**
 * Decides once per launch whether "What's new" opens, from the profile's last
 * seen version and the version this process runs, and records the running one
 * — at once when there is nothing to show, otherwise when the dialog is
 * dismissed.
 */
export function useWhatsNew(
  changelog: readonly ChangelogRelease[],
): WhatsNewController {
  const [shown, setShown] = useState<{
    releases: ChangelogRelease[];
    record: string;
    since: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.geniro.getStatus(), window.geniro.getSettings()])
      .then(([status, settings]) => {
        if (cancelled) {
          return;
        }
        const plan = planWhatsNew({
          releases: changelog,
          lastSeen: settings.lastSeenChangelogVersion,
          current: status.appVersion,
          isPackaged: status.isPackaged,
          onboardingComplete: status.onboardingComplete,
        });
        if (plan.record === null) {
          return;
        }
        if (plan.show.length > 0) {
          setShown({
            releases: plan.show,
            record: plan.record,
            since: plan.since,
          });
        } else {
          void window.geniro
            .updateSettings({ lastSeenChangelogVersion: plan.record })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [changelog]);

  const dismiss = useLatestCallback(() => {
    if (shown === null) {
      return;
    }
    setShown(null);
    void window.geniro
      .updateSettings({ lastSeenChangelogVersion: shown.record })
      .catch(() => undefined);
  }, [shown]);

  return {
    releases: shown?.releases ?? [],
    since: shown?.since ?? null,
    current: shown?.record ?? null,
    dismiss,
  };
}
