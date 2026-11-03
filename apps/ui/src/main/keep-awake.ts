import type { DaemonHandle } from '../shared/contracts';
import { defaultCheckBusy } from './daemon-supervisor';

export const KEEP_AWAKE_POLL_MS = 15_000;
/** Failed readings in a row a hold survives, so one slow answer from a busy daemon does not drop it. */
export const KEEP_AWAKE_MAX_FAILED_READINGS = 3;
const ACTIVITY_PATH = '/v1/agents/activity';
const ACTIVITY_TIMEOUT_MS = 5_000;

/** The slice of Electron's `powerSaveBlocker` this module uses. */
export interface SleepBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): boolean;
}

export interface KeepAwakeOptions {
  blocker: SleepBlocker;
  getHandle: () => DaemonHandle | null;
  readWorking?: (handle: DaemonHandle) => Promise<boolean>;
  report?: (message: string) => void;
  pollMs?: number;
}

/** TWIN PARSER: `AgentActivitySchema` in `apps/daemon/src/v1/agents/chat.types.ts`. */
export function parseAgentActivity(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const working = (body as Record<string, unknown>).working;
  return typeof working === 'boolean' ? working : null;
}

/**
 * A daemon from before the route answers 404 and is asked the supervisor's
 * own question (a chat or team run live), which misses work between turns.
 */
export async function readAgentsWorking(
  handle: DaemonHandle,
  fetchImpl: typeof fetch = fetch,
  checkBusy: (handle: DaemonHandle) => Promise<boolean> = defaultCheckBusy,
): Promise<boolean> {
  const response = await fetchImpl(
    `http://${handle.host}:${handle.port}${ACTIVITY_PATH}`,
    {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(ACTIVITY_TIMEOUT_MS),
    },
  );
  if (response.status === 404) {
    return checkBusy(handle);
  }
  if (!response.ok) {
    throw new Error(`${ACTIVITY_PATH} answered ${response.status}`);
  }
  const working = parseAgentActivity(await response.json());
  if (working === null) {
    throw new Error(`${ACTIVITY_PATH} answered an unreadable body`);
  }
  return working;
}

/**
 * Keeps the Mac from idle sleep while the daemon's agents work
 * (`Settings.preventSleepWhileWorking`).
 *
 * `prevent-app-suspension` is macOS's PreventUserIdleSystemSleep: the display
 * still dims and sleeps, and closing the lid still sleeps the Mac. The
 * assertion belongs to this process, so the OS drops it if the app dies.
 */
export class KeepAwake {
  private enabled = false;
  private holdId: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failedReadings = 0;
  private generation = 0;
  private readonly readWorking: (handle: DaemonHandle) => Promise<boolean>;
  private readonly report: (message: string) => void;
  private readonly pollMs: number;

  constructor(private readonly options: KeepAwakeOptions) {
    this.readWorking = options.readWorking ?? readAgentsWorking;
    this.report = options.report ?? (() => undefined);
    this.pollMs = options.pollMs ?? KEEP_AWAKE_POLL_MS;
  }

  get holding(): boolean {
    return this.holdId !== null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.restart();
    if (enabled) {
      void this.tick();
    } else {
      this.release('the setting was turned off');
    }
  }

  /** Read again now — a daemon just came up, so a turn may already be running. */
  poke(): void {
    if (this.enabled) {
      this.restart();
      void this.tick();
    }
  }

  dispose(): void {
    this.enabled = false;
    this.restart();
    this.release('the app is quitting');
  }

  /** Ends the loop in flight: a reading that lands after this is dropped. */
  private restart(): void {
    this.generation += 1;
    this.failedReadings = 0;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const generation = this.generation;
    const reading = await this.read();
    if (generation !== this.generation) {
      return;
    }
    if (reading === 'no daemon') {
      this.failedReadings = 0;
      this.release('the daemon is not running');
    } else if (reading instanceof Error) {
      this.failedReadings += 1;
      if (this.failedReadings === 1) {
        this.report(
          `could not ask the daemon whether agents work: ${reading.message}`,
        );
      }
      if (this.failedReadings >= KEEP_AWAKE_MAX_FAILED_READINGS) {
        this.release('the daemon did not answer');
      }
    } else {
      this.failedReadings = 0;
      if (reading) {
        this.hold();
      } else {
        this.release('no agent is working');
      }
    }
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  private async read(): Promise<boolean | Error | 'no daemon'> {
    const handle = this.options.getHandle();
    if (handle === null) {
      return 'no daemon';
    }
    try {
      return await this.readWorking(handle);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private hold(): void {
    if (this.holdId !== null) {
      return;
    }
    this.holdId = this.options.blocker.start('prevent-app-suspension');
    this.report('keeping the Mac awake: agents are working');
  }

  private release(why: string): void {
    if (this.holdId === null) {
      return;
    }
    this.options.blocker.stop(this.holdId);
    this.holdId = null;
    this.report(`letting the Mac sleep again: ${why}`);
  }
}
