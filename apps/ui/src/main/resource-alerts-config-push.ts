import type { ResourceAlertSettings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/**
 * Hands the daemon the user's resource watch settings
 * (`PUT /v1/resource-alerts/config`) — see {@link DaemonConfigPush}. Until the
 * first push lands the daemon watches with the default thresholds.
 *
 * TWIN PARSER: `ResourceAlertConfigSchema` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export class ResourceAlertsConfigPush extends DaemonConfigPush<ResourceAlertSettings> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/resource-alerts/config',
        what: 'the resource alert settings',
        untilSaved:
          'the daemon keeps its previous resource alert settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
