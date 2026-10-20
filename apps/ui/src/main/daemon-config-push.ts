import type { DaemonHandle } from '../shared/contracts';

const PUSH_TIMEOUT_MS = 5_000;

/** What one pushed value is called in a report, and what a refusal leaves. */
export interface DaemonConfigPushLabels {
  /** The route, e.g. `/v1/shares/config`. */
  path: string;
  /** The value as a report names it, e.g. "the sharing settings". */
  what: string;
  /** What holds until the next push lands, after a refusal. */
  untilSaved: string;
}

/**
 * Hands the daemon one value main keeps in settings.json, with a `PUT`.
 *
 * The daemon reads no settings.json of its own and keeps these in memory only,
 * so every daemon must be told: on each start (`onStarted`), after a restart
 * from Settings (which `onStarted` does not cover), and after each settings
 * write that changed them. The body is written by hand because main holds no
 * generated client (that is the renderer's); each route's schema names its
 * pusher as a TWIN PARSER.
 */
export class DaemonConfigPush<T> {
  /** The last value a daemon accepted, so an unrelated settings write sends nothing. */
  private lastPushed: string | null = null;

  constructor(
    private readonly labels: DaemonConfigPushLabels,
    private readonly report: (message: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Push unconditionally — a daemon that just came up holds nothing. */
  async push(handle: DaemonHandle, value: T): Promise<void> {
    const body = JSON.stringify(value);
    try {
      const response = await this.fetchImpl(
        `http://${handle.host}:${handle.port}${this.labels.path}`,
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
          `the daemon refused ${this.labels.what} (${response.status}); ${this.labels.untilSaved}`,
        );
        return;
      }
      this.lastPushed = body;
    } catch (error) {
      this.lastPushed = null;
      this.report(
        `${this.labels.what} could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Push only when the value differs from what the daemon last accepted. */
  async pushIfChanged(handle: DaemonHandle | null, value: T): Promise<void> {
    if (handle === null || JSON.stringify(value) === this.lastPushed) {
      return;
    }
    await this.push(handle, value);
  }
}
