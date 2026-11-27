import { useEffect, useMemo } from 'react';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { isRemoteRuntime } from '../remote/remote-session';
import { useCliAttention } from '../settings/use-cli-attention';
import { useUpdateState } from '../updates/use-update-state';
import { useCliLogin } from '../use-cli-login';
import {
  ON_SHARES,
  readMemoryFindings,
  readWaitingShares,
  shareWaitsByPlace,
  useConfigProfiles,
} from './settings-attention';
import type { SettingsNoticesStore } from './settings-notices-context';
import type { ManagerNotices } from './use-manager-notices';
import { ON_MEMORY, useWaitingSet } from './use-waiting-items';

const ignoreDismiss = (): void => undefined;

/**
 * Everything the manager chat's Settings notice rows draw from: the notices
 * the daemon keeps (`manager`, read by the command center), and the same live
 * readings Settings draws.
 */
export function useSettingsNotices({
  apis,
  client,
  active,
  manager,
  onOpenMemoryConflicts,
  remote = isRemoteRuntime(),
}: {
  apis: DaemonApis;
  client: DaemonClient | null;
  active: boolean;
  manager: ManagerNotices | null;
  onOpenMemoryConflicts: (() => void) | null;
  remote?: boolean;
}): SettingsNoticesStore {
  const cli = useCliAttention();
  const { refresh } = cli;
  const notices = manager?.notices ?? null;
  useEffect(() => {
    if (active) {
      refresh(false);
    }
  }, [active, notices, refresh]);
  const login = useCliLogin(apis, () => refresh(true));
  const update = useUpdateState();
  const profiles = useConfigProfiles();
  const shares = useWaitingSet(
    apis,
    client,
    active && !remote,
    readWaitingShares,
    ON_SHARES,
  );
  const findings = useWaitingSet(
    apis,
    client,
    active,
    readMemoryFindings,
    ON_MEMORY,
  );
  const dismiss = manager?.dismiss ?? ignoreDismiss;

  const shareWaits = useMemo(
    () =>
      remote || shares.items === null
        ? null
        : shareWaitsByPlace(shares.items.values()),
    [shares.items],
  );
  const conflictIds = useMemo(
    () => (findings.items === null ? null : [...findings.items.keys()]),
    [findings.items],
  );
  return useMemo(
    () => ({
      apis,
      notices,
      dismiss,
      detections: cli.detections,
      cliUpdates: cli.updates,
      login,
      update,
      profiles,
      shareWaits,
      conflictIds,
      onOpenMemoryConflicts,
      remote,
    }),
    [
      apis,
      notices,
      dismiss,
      cli.detections,
      cli.updates,
      login,
      update,
      profiles,
      shareWaits,
      conflictIds,
      onOpenMemoryConflicts,
      remote,
    ],
  );
}
