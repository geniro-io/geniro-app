import type { SharingSettings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/**
 * Hands the daemon the user's sharing settings (`PUT /v1/shares/config`) — see
 * {@link DaemonConfigPush}. Until the first push lands nothing can be shared.
 *
 * TWIN PARSER: `ShareConfigSchema` in `apps/daemon/src/v1/shares/shares.types.ts`.
 */
export class ShareConfigPush extends DaemonConfigPush<SharingSettings> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/shares/config',
        what: 'the sharing settings',
        untilSaved: 'sharing stays off until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
