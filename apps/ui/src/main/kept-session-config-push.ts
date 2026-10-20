import { DaemonConfigPush } from './daemon-config-push';

/** The body of `PUT /v1/agents/sessions/config`. */
export interface KeptSessionConfig {
  idleMinutes: number;
}

/**
 * Hands the daemon the user's kept-session idle window
 * (`Settings.keptSessionIdleMinutes`, `PUT /v1/agents/sessions/config`) — see
 * {@link DaemonConfigPush}. Until the first push lands the daemon keeps its
 * default hour.
 *
 * TWIN PARSER: `KeptSessionConfigSchema` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export class KeptSessionConfigPush extends DaemonConfigPush<KeptSessionConfig> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/agents/sessions/config',
        what: 'the kept-session idle window',
        untilSaved:
          'the daemon keeps its previous window until it is saved again',
      },
      report,
      fetchImpl,
    );
  }
}
