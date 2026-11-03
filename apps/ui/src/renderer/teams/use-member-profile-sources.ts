import { useEffect, useState } from 'react';

import type { CliKind, ConfigProfile } from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';

/**
 * How many config directories the picker remembers. The same cap the composer
 * keeps — the two write one list.
 */
const RECENT_CONFIG_DIRS = 5;

export interface MemberProfileSources {
  /** The config directories the composer's chip also offers, per CLI. */
  recentConfigDirs: Partial<Record<CliKind, string[]>>;
  configProfiles: readonly ConfigProfile[];
  /**
   * Browse for a folder to use as `agent`'s profile and remember it among the
   * recent ones; null when the user cancelled.
   */
  browse: (agent: CliKind) => Promise<string | null>;
}

/** The profiles a member's pickers offer, read from settings while the screen is on view. */
export function useMemberProfileSources(active: boolean): MemberProfileSources {
  const [recentConfigDirs, setRecentConfigDirs] = useState<
    Partial<Record<CliKind, string[]>>
  >({});
  const [configProfiles, setConfigProfiles] = useState<
    readonly ConfigProfile[]
  >([]);
  useEffect(() => {
    if (!active) {
      return;
    }
    void window.geniro
      .getSettings()
      .then((settings) => {
        setRecentConfigDirs(settings.recentConfigDirs ?? {});
        setConfigProfiles(settings.configProfiles ?? []);
      })
      .catch(() => undefined);
  }, [active]);

  /** Writes back only `recentConfigDirs`, merged into the list as it stands now. */
  const browse = useLatestCallback(
    async (agent: CliKind): Promise<string | null> => {
      const chosen = await window.geniro.pickProjectFolder();
      if (chosen === null) {
        return null;
      }
      const stored = await window.geniro
        .getSettings()
        .then((settings) => settings.recentConfigDirs ?? recentConfigDirs)
        .catch(() => recentConfigDirs);
      const current = stored[agent] ?? [];
      const next = {
        ...stored,
        [agent]: [chosen, ...current.filter((path) => path !== chosen)].slice(
          0,
          RECENT_CONFIG_DIRS,
        ),
      };
      setRecentConfigDirs(next);
      void window.geniro.updateSettings({ recentConfigDirs: next });
      return chosen;
    },
    [recentConfigDirs],
  );

  return { recentConfigDirs, configProfiles, browse };
}
