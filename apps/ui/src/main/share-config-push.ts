import type { DaemonHandle, SharingSettings } from '../shared/contracts';

const PUSH_TIMEOUT_MS = 5_000;

/**
 * Hands the daemon the user's sharing settings (`PUT /v1/shares/config`).
 *
 * The daemon reads no settings.json of its own and keeps these in memory only,
 * so every daemon must be told: on each start (`onStarted`), after a restart
 * from Settings (which `onStarted` does not cover), and after each settings
 * write that changed them. Until the first push lands nothing can be shared.
 *
 * TWIN PARSER: `ShareConfigSchema` in `apps/daemon/src/v1/shares/shares.types.ts`.
 * The body is written by hand because main holds no generated client (that is
 * the renderer's).
 */
export class ShareConfigPush {
  /** The last value a daemon accepted, so an unrelated settings write sends nothing. */
  private lastPushed: string | null = null;

  constructor(
    private readonly report: (message: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Push unconditionally — a daemon that just came up holds nothing. */
  async push(handle: DaemonHandle, sharing: SharingSettings): Promise<void> {
    const body = JSON.stringify(sharing);
    try {
      const response = await this.fetchImpl(
        `http://${handle.host}:${handle.port}/v1/shares/config`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${handle.token}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.lastPushed = null;
        this.report(
          `the daemon refused the sharing settings (${response.status}); sharing stays off until they are saved again`,
        );
        return;
      }
      this.lastPushed = body;
    } catch (error) {
      this.lastPushed = null;
      this.report(
        `the sharing settings could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Push only when the value differs from what the daemon last accepted. */
  async pushIfChanged(
    handle: DaemonHandle | null,
    sharing: SharingSettings,
  ): Promise<void> {
    if (handle === null || JSON.stringify(sharing) === this.lastPushed) {
      return;
    }
    await this.push(handle, sharing);
  }
}
