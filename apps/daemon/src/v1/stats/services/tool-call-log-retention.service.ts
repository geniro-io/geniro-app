import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import {
  JOURNAL_DELETE_WINDOW_MAX,
  UsageCounterDao,
} from '../dao/usage-counter.dao';
import { UsageCounterBackfillService } from './usage-counter-backfill.service';

/** The first sweep after a start, then one a day. */
export const TOOL_CALL_LOG_SWEEP_FIRST_MS = 5 * 60_000;
export const TOOL_CALL_LOG_SWEEP_EVERY_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Prunes the per-call tool journal (`tool_call_events`) to the retention the
 * desktop app pushed. Nothing is deleted before the app has pushed a value,
 * nor before the backfill has folded every older row into the counters; the
 * counters themselves are never pruned. Deletes go in windows of at most
 * {@link JOURNAL_DELETE_WINDOW_MAX} rows, with a turn of the event loop
 * between them.
 */
@Injectable()
export class ToolCallLogRetentionService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ToolCallLogRetentionService.name);
  private retentionDays: number | null | undefined = undefined;
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private sweeping: Promise<number> | null = null;

  constructor(
    private readonly dao: UsageCounterDao,
    private readonly backfill: UsageCounterBackfillService,
  ) {}

  onModuleInit(): void {
    this.first = setTimeout(() => {
      void this.sweepQuietly();
      this.every = setInterval(() => {
        void this.sweepQuietly();
      }, TOOL_CALL_LOG_SWEEP_EVERY_MS);
      this.every.unref();
    }, TOOL_CALL_LOG_SWEEP_FIRST_MS);
    this.first.unref();
  }

  onApplicationShutdown(): void {
    if (this.first !== null) {
      clearTimeout(this.first);
    }
    if (this.every !== null) {
      clearInterval(this.every);
    }
  }

  /** The days of journal kept; null keeps it forever. */
  configure(retentionDays: number | null): void {
    this.retentionDays = retentionDays;
  }

  get configured(): number | null | undefined {
    return this.retentionDays;
  }

  /** Delete every journal row past the retention; how many went. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.sweeping !== null) {
      return this.sweeping;
    }
    this.sweeping = this.prune(now).finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async prune(now: number): Promise<number> {
    const days = this.retentionDays;
    if (days === undefined || days === null || !this.backfill.done) {
      return 0;
    }
    const before = now - days * DAY_MS;
    let deleted = 0;
    for (;;) {
      const count = await this.dao.deleteJournalBefore(
        before,
        JOURNAL_DELETE_WINDOW_MAX,
      );
      deleted += count;
      if (count < JOURNAL_DELETE_WINDOW_MAX) {
        return deleted;
      }
      await yieldToEventLoop();
    }
  }

  private async sweepQuietly(): Promise<void> {
    try {
      const deleted = await this.sweep();
      if (deleted > 0) {
        this.logger.log(`pruned ${deleted} tool log row(s) past the retention`);
      }
    } catch (err) {
      this.logger.warn(
        `tool log retention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
