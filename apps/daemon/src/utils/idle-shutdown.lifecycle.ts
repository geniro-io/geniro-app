import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { ProcessRegistry } from '../v1/agents/services/process-registry';
import { WsPresenceService } from '../v1/notifications/services/ws-presence.service';

/** How often idleness is re-checked, capped so a short window still gets several looks. */
const MAX_POLL_INTERVAL_MS = 60_000;

/** Test seams — the production factory passes nothing. */
export interface IdleShutdownOptions {
  now?: () => number;
  /** Triggers the graceful shutdown. Defaults to a SIGTERM at ourselves. */
  shutdown?: () => void;
  logger?: { log(msg: string): void };
}

/**
 * Exit when nobody is using this daemon.
 *
 * The daemon outlives the app that spawned it whenever the app does not get to
 * ask it to stop: a force-quit, a crash, a `kill -9` on the Electron shell. The
 * UI supervisor only ever terminates the daemon it OWNS, and it cannot own one
 * left behind by a launch that is gone — so without this, that daemon runs
 * until the machine reboots, holding a port, a SQLite handle and ~150 MB.
 *
 * "Idle" is deliberately two conditions, not one. No connected client is what
 * makes it unused; no in-flight turn is what makes it safe to stop. A workflow
 * run keeps going after its window closes, and exiting on the first condition
 * alone would kill work the user is waiting on.
 *
 * SIGTERM at ourselves rather than a direct exit: that is the path Nest's
 * shutdown hooks are on, so the ProcessRegistry drain reaps the spawned CLI
 * groups and the pidfile is cleared — the same shutdown a clean quit performs.
 * Exiting straight out would create exactly the strays the child journal
 * exists to clean up after.
 *
 * Disabled unless the environment names a window ({@link IdleShutdownOptions}
 * is seeded from `GENIRO_IDLE_EXIT_MS`, which only the Electron supervisor
 * sets). A `pnpm daemon:dev` daemon has no client by design and must not
 * interpret that as being unwanted.
 */
@Injectable()
export class IdleShutdownLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether the shutdown has already been asked for.
   *
   * Clearing the interval is not enough on its own: the shutdown is
   * asynchronous, and a check already queued when it started would SIGTERM a
   * daemon that is part-way through draining its children.
   */
  private triggered = false;
  private idleSince: number;
  private readonly now: () => number;
  private readonly shutdown: () => void;
  private readonly logger: NonNullable<IdleShutdownOptions['logger']>;

  constructor(
    private readonly idleExitMs: number | null,
    private readonly presence: WsPresenceService,
    private readonly processes: ProcessRegistry,
    options: IdleShutdownOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.shutdown =
      options.shutdown ?? (() => process.kill(process.pid, 'SIGTERM'));
    this.logger = options.logger ?? new Logger(IdleShutdownLifecycle.name);
    // The clock starts at construction, not at the first client: a daemon
    // nobody ever connects to is the case this is for.
    this.idleSince = this.now();
  }

  onApplicationBootstrap(): void {
    if (this.idleExitMs === null) {
      return;
    }
    this.timer = setInterval(
      () => this.check(),
      Math.min(this.idleExitMs, MAX_POLL_INTERVAL_MS),
    );
    // Never hold the event loop open on the daemon's account — this timer must
    // not be the reason the process stays alive.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One idleness check. Exposed so a spec can drive it without a real clock. */
  check(): void {
    if (this.idleExitMs === null || this.triggered) {
      return;
    }
    if (this.presence.connected > 0 || this.processes.activeCount > 0) {
      this.idleSince = this.now();
      return;
    }
    const idleFor = this.now() - this.idleSince;
    if (idleFor < this.idleExitMs) {
      return;
    }
    this.triggered = true;
    this.logger.log(
      `no client and no turn in flight for ${Math.round(idleFor / 1000)}s — shutting down`,
    );
    // Stop checking before handing over, so nothing is left armed against a
    // daemon that is already on its way out.
    this.onApplicationShutdown();
    this.shutdown();
  }
}
