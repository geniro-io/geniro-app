import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

/** How long the loop may go without turning before the debug log hears of it. */
export const EVENT_LOOP_BLOCK_WARN_MS = 1_000;

const CHECK_EVERY_MS = 250;

/**
 * Writes a warning to the debug log whenever the event loop could not turn for
 * {@link EVENT_LOOP_BLOCK_WARN_MS} or more. Every query the daemon makes is
 * synchronous, so a long stretch of them freezes every request and the `/ws`
 * ping at once; this names how long each such freeze was and when it ended,
 * beside the slow-statement lines (`db/slow-statement-log.ts`) of what ran.
 *
 * Measured as the lateness of its own timer, never from
 * `monitorEventLoopDelay`: resetting that histogram from a check that runs
 * before its sampler after a block drops the block's sample.
 */
@Injectable()
export class EventLoopWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopWatchdogService.name);
  private lastCheckAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  onModuleInit(): void {
    this.lastCheckAt = performance.now();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastCheckAt = null;
  }

  /** Warns when the loop stood still since the last check for longer than allowed. */
  check(): void {
    if (this.lastCheckAt === null) {
      return;
    }
    const now = performance.now();
    const blockedMs = Math.round(now - this.lastCheckAt - CHECK_EVERY_MS);
    this.lastCheckAt = now;
    if (blockedMs >= EVENT_LOOP_BLOCK_WARN_MS) {
      this.logger.warn(`event loop blocked for ${blockedMs} ms`);
    }
  }
}
