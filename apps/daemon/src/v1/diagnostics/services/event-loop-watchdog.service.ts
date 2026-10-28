import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

/** How long the loop may go without turning before the debug log hears of it. */
export const EVENT_LOOP_BLOCK_WARN_MS = 1_000;

const CHECK_EVERY_MS = 1_000;

/**
 * Writes a warning to the debug log whenever the event loop could not turn for
 * {@link EVENT_LOOP_BLOCK_WARN_MS} or more. Every query the daemon makes is
 * synchronous, so a long stretch of them freezes every request and the `/ws`
 * ping at once; this names how long each such freeze was and when it ended,
 * beside the slow-statement lines (`db/slow-statement-log.ts`) of what ran.
 */
@Injectable()
export class EventLoopWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopWatchdogService.name);
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  onModuleInit(): void {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    this.histogram = histogram;
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram?.disable();
    this.histogram = null;
  }

  /** Reads and resets the delay seen since the last check. */
  check(): void {
    const histogram = this.histogram;
    if (histogram === null) {
      return;
    }
    const blockedMs = Math.round(histogram.max / 1e6);
    histogram.reset();
    if (blockedMs >= EVENT_LOOP_BLOCK_WARN_MS) {
      this.logger.warn(`event loop blocked for ${blockedMs} ms`);
    }
  }
}
