import { DaemonConfigPush } from './daemon-config-push';

/** The body of `PUT /v1/stats/tool-usage/config`. */
export interface ToolUsageConfig {
  toolCallLogRetentionDays: number | null;
}

/**
 * Hands the daemon how long it keeps the per-call tool log
 * (`Settings.toolCallLogRetentionDays`, `PUT /v1/stats/tool-usage/config`) —
 * see {@link DaemonConfigPush}. Until the first push lands the daemon deletes
 * nothing.
 *
 * TWIN PARSER: `ToolUsageConfigSchema` in `apps/daemon/src/v1/stats/stats.types.ts`.
 */
export class ToolUsageConfigPush extends DaemonConfigPush<ToolUsageConfig> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/stats/tool-usage/config',
        what: 'the tool log retention',
        untilSaved:
          'the daemon keeps its previous retention until it is saved again',
      },
      report,
      fetchImpl,
    );
  }
}
