import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';

@Injectable()
export class UsageEventDao extends BaseDao<UsageEvent> {
  constructor(em: EntityManager) {
    super(em, UsageEvent);
  }

  /**
   * Write one turn's usage, or do nothing if that turn is already recorded.
   * Answers whether the row was NEW, which is what lets the backfill report how
   * much history it actually recovered.
   *
   * The check is a read followed by a write rather than a caught constraint
   * violation, because the two writers are a bus subscriber and a boot-time
   * sweep that never run concurrently within one daemon, and one daemon per
   * userData directory is enforced by the instance lock. The unique index is
   * still there as the backstop — if that assumption ever stops holding, the
   * database refuses the duplicate instead of the ledger quietly double-counting
   * someone's spend.
   */
  async recordOnce(
    row: UsageEventInput,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const existing = await this.getRepo(txEm).findOne(
      { runId: row.runId, seq: row.seq },
      { fields: ['id'], disableIdentityMap: true },
    );
    if (existing) {
      return false;
    }
    await this.create(row, txEm);
    return true;
  }

  /**
   * Every turn recorded in a period, oldest first — the one query the whole
   * stats page is built on. Bounded by the range rather than paged: a row is a
   * handful of integers, and the aggregation needs all of them to bucket.
   *
   * The range is half-open (`from` inclusive, `to` exclusive) so consecutive
   * periods tile without a turn landing in both.
   */
  async inRange(
    from: Date,
    to: Date,
    txEm?: EntityManager,
  ): Promise<UsageEvent[]> {
    return this.getRepo(txEm).find(
      { occurredAt: { $gte: from, $lt: to } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * The `(runId, seq)` pairs already recorded, as a set of composite keys — what
   * the backfill filters its candidate items against.
   *
   * One projected query rather than a `findOne` per candidate: a profile with
   * thousands of turns would otherwise pay a round trip each, on every boot,
   * to learn that it has nothing to do.
   */
  async recordedKeys(since?: Date, txEm?: EntityManager): Promise<Set<string>> {
    const rows = await this.getRepo(txEm).find(
      since === undefined ? {} : { occurredAt: { $gte: since } },
      { fields: ['runId', 'seq'], disableIdentityMap: true },
    );
    return new Set(rows.map((row) => `${row.runId}:${row.seq}`));
  }

  /**
   * The most recent turn the ledger holds, or null when it holds none — the
   * boot sweep's high-water mark.
   */
  async latestOccurredAt(txEm?: EntityManager): Promise<Date | null> {
    const last = await this.getRepo(txEm).findOne(
      {},
      {
        orderBy: { occurredAt: 'desc' },
        fields: ['occurredAt'],
        disableIdentityMap: true,
      },
    );
    return last ? last.occurredAt : null;
  }

  /**
   * When the ledger's history starts, or null when it holds nothing — what an
   * "all time" range resolves its lower bound to.
   */
  async earliestOccurredAt(txEm?: EntityManager): Promise<Date | null> {
    const first = await this.getRepo(txEm).findOne(
      {},
      {
        orderBy: { occurredAt: 'asc' },
        fields: ['occurredAt'],
        disableIdentityMap: true,
      },
    );
    return first ? first.occurredAt : null;
  }
}
