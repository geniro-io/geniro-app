import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { eventLoopSlicer } from '../../agents/utils/event-loop-slices';
import {
  USAGE_COUNTER_ADD_BATCH,
  UsageCounterDao,
} from '../dao/usage-counter.dao';
import type {
  UsageCounterDelta,
  UsageCounterKey,
  UsageCounterRow,
} from '../stats.types';
import {
  addDelta,
  emptyDelta,
  usageCounterKeyOf,
} from '../utils/usage-counter-delta';

/** How often buffered deltas are written. */
export const USAGE_COUNTER_FLUSH_MS = 30_000;

/**
 * Holds usage deltas in memory and writes them every
 * {@link USAGE_COUNTER_FLUSH_MS} and at shutdown, so counting a use never
 * touches the database on the call's path. A delta leaves the buffer only once
 * its batch committed; a failed batch goes back for the next flush.
 */
@Injectable()
export class UsageCounterService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(UsageCounterService.name);
  private pending = new Map<string, UsageCounterRow>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private warned = false;

  constructor(private readonly dao: UsageCounterDao) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, USAGE_COUNTER_FLUSH_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  add(key: UsageCounterKey, delta: Partial<UsageCounterDelta>): void {
    const id = usageCounterKeyOf(key);
    const held = this.pending.get(id) ?? { ...key, ...emptyDelta() };
    this.pending.set(id, addDelta(held, { ...emptyDelta(), ...delta }));
  }

  /** Deltas not yet written. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Write what is buffered; a flush already running is joined, not doubled. */
  async flush(): Promise<void> {
    while (this.flushing !== null) {
      await this.flushing;
    }
    if (this.pending.size === 0) {
      return;
    }
    this.flushing = this.write().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async write(): Promise<void> {
    const rows = [...this.pending.values()];
    this.pending = new Map();
    const yieldTurn = eventLoopSlicer();
    for (let at = 0; at < rows.length; at += USAGE_COUNTER_ADD_BATCH) {
      const batch = rows.slice(at, at + USAGE_COUNTER_ADD_BATCH);
      try {
        await this.dao.add(batch);
      } catch (err) {
        for (const row of rows.slice(at)) {
          this.add(row, row);
        }
        if (!this.warned) {
          this.warned = true;
          this.logger.warn(
            `usage counters were not written; kept for the next flush: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
      await yieldTurn();
    }
    this.warned = false;
  }
}
