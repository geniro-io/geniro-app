import { useEffect } from 'react';

import type { CliDetection, UpdateState } from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { reportedNoticeReadings } from './settings-attention';

/**
 * The desktop window tells the daemon what Electron main reads of the Geniro
 * update and the agent CLIs whenever that reading changes, and again after a
 * reconnect, so the manager chat's notices open when the reason comes up,
 * whether or not the chat is open. A paired device reads none of it.
 */
export function useNoticeReadingsReport({
  apis,
  client,
  detections,
  update,
  remote,
}: {
  apis: DaemonApis | null;
  client: DaemonClient | null;
  detections: readonly CliDetection[] | null;
  update: UpdateState | null;
  remote: boolean;
}): void {
  const readings = reportedNoticeReadings(detections, update);
  const readingsKey = JSON.stringify(readings);
  const report = useLatestCallback(() => {
    if (apis === null || remote || readings.length === 0) {
      return;
    }
    void apis.commandCenter
      .reportCommandCenterNoticeReadings({
        settingsNoticeReadingsDto: { readings },
      })
      .catch(() => undefined);
  }, [apis, remote, readingsKey]);

  useEffect(() => {
    report();
  }, [apis, remote, readingsKey, report]);

  useEffect(
    () => (client === null ? undefined : client.onReconnect(report)),
    [client, report],
  );
}
